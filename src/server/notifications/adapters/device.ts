/** Deliver a notification to a signed-in iOS device through APNs. */
import { db } from '~/db';
import { getPlatformEnv } from '~/env';
import type { NotificationApnsEnvironment } from '~/db/schema';
import {
  APNS_ORIGINS,
  invalidateProviderToken,
  sendApnsRequest,
  type ApnsSendRequest,
  type ApnsSendResult,
} from '../apns/client';
import { getApnsCredentials } from '../apns/credentials';
import {
  MAX_ANSWERED_SUMMARY,
  RECALLED_TITLE,
  buildEncryptedApnsPayload,
  type PushPlaintext,
  type PushPriority,
  type PushReply,
} from '../apns/payload';
import {
  notificationSourceId,
  notificationText,
  type NotificationEvent,
  type NotificationRecord,
  type NotificationResponseRecord,
} from '../contract';
import {
  replyPushMode,
  summarizeAnswers,
} from '../../../../packages/hatch-platform-api/notification-reply';
import type { DeliveryAdapter, DeliveryOutcome } from '../delivery';
import { decryptDeviceKey } from '../secrets';

/** Undelivered pushes are useless after a day; APNs drops them then. */
const PUSH_EXPIRY_MS = 24 * 60 * 60_000;

/** Recorded on device deliveries of lowest-priority notifications. */
export const LOWEST_PRIORITY_RESULT =
  'Not pushed: lowest-priority notifications only appear in history.';

/** APNs rejections meaning this token will never work again. */
const DEAD_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'Unregistered',
  'DeviceTokenNotForTopic',
]);
/** APNs rejections caused by this instance's credentials or configuration. */
const CREDENTIAL_REASONS = new Set([
  'InvalidProviderToken',
  'MissingProviderToken',
  'BadCertificate',
  'BadCertificateEnvironment',
  'Forbidden',
  'TopicDisallowed',
  'BadTopic',
  'MissingTopic',
]);

export function classifyApnsResult(result: ApnsSendResult): DeliveryOutcome {
  if (result.status === 200) {
    return {
      kind: 'success',
      httpStatus: 200,
      destination: { lastError: null },
    };
  }
  const reason = result.reason ?? 'Unknown';
  const error = `APNs rejected the push (${result.status} ${reason}).`;
  if (result.status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
    return {
      kind: 'fail',
      httpStatus: result.status,
      error: `${error} The device is no longer registered and was disabled.`,
      destination: { disable: true, lastError: error },
    };
  }
  if (reason === 'ExpiredProviderToken') {
    return { kind: 'retry', httpStatus: result.status, error };
  }
  if (result.status === 403 || CREDENTIAL_REASONS.has(reason)) {
    return {
      kind: 'fail',
      httpStatus: result.status,
      error: `${error} Check this instance's APNs credentials.`,
      destination: { lastError: error },
    };
  }
  if (result.status === 429 || result.status >= 500) {
    return { kind: 'retry', httpStatus: result.status, error };
  }
  return { kind: 'fail', httpStatus: result.status, error };
}

function shorten(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** How the phone offers the reply form, or shows the answer once given. */
export function pushReply(
  notification: Pick<NotificationRecord, 'reply'>,
  response: NotificationResponseRecord | null,
): PushReply | undefined {
  const { reply } = notification;
  if (!reply) return undefined;
  if (response) {
    const summary = summarizeAnswers(reply, response.answers);
    return {
      m: 'x',
      s: shorten(
        `Answered by ${response.respondedByName}${summary ? `: ${summary}` : ''}`,
        MAX_ANSWERED_SUMMARY,
      ),
    };
  }
  const [field] = reply.fields;
  switch (replyPushMode(reply)) {
    case 'buttons':
      if (field?.type !== 'buttons') return { m: 'f' };
      return {
        m: 'b',
        f: field.id,
        a: field.options.map((option) => ({
          i: option.id,
          l: option.label,
          ...(option.destructive ? { d: 1 as const } : {}),
        })),
      };
    case 'text':
      if (field?.type !== 'text') return { m: 'f' };
      return {
        m: 't',
        f: field.id,
        l: reply.submitLabel,
        ...(field.placeholder ? { p: field.placeholder } : {}),
      };
    case 'form':
      return { m: 'f' };
  }
}

/**
 * The words a push shows: a text notification's title over its summary (or
 * its body without one); for markdown and card, which a push cannot render,
 * the source name over the summary.
 */
function pushText(
  notification: NotificationRecord,
): Pick<PushPlaintext, 't' | 'b' | 'ks'> {
  if (notification.format === 'text') {
    return {
      t: notification.title ?? '',
      b: notification.summary ?? notification.body,
    };
  }
  return {
    t: notification.sourceName,
    b: notification.summary ?? notificationText(notification),
    ks: 1,
  };
}

/**
 * What the phone decrypts. A recall carries no content, so a phone that
 * cannot hide the notification only shows that it was recalled.
 */
export function pushPlaintext(
  notification: NotificationRecord,
  event: NotificationEvent,
  origin: string,
  response: NotificationResponseRecord | null = null,
  silent = false,
): PushPlaintext {
  const base = {
    v: 1 as const,
    id: notification.id,
    o: origin,
    s: notification.sourceName,
    k: notification.kindName,
    g: notificationSourceId(notification) ?? notification.sourceType,
    at: notification.occurredAt.toISOString(),
    r: notification.revision,
  };
  if (event === 'recalled') {
    return { ...base, t: RECALLED_TITLE, b: null, u: null, e: 'r' };
  }
  const q = pushReply(notification, response);
  return {
    ...base,
    ...pushText(notification),
    u: notification.url,
    ...(notification.url && notification.autoOpenUrl
      ? { ao: true as const }
      : {}),
    ...(event === 'updated'
      ? {
          e: 'u' as const,
          ...(!silent && notification.priority >= 0
            ? { a: true as const }
            : {}),
        }
      : {}),
    ...(q ? { q } : {}),
  };
}

function pushPriority(priority: number): PushPriority {
  if (priority >= 1) return 1;
  return priority <= -1 ? -1 : 0;
}

export function createDeviceAdapter(
  options: {
    send?: (request: ApnsSendRequest) => Promise<ApnsSendResult>;
    origins?: Record<NotificationApnsEnvironment, string>;
  } = {},
): DeliveryAdapter {
  const send = options.send ?? sendApnsRequest;
  const origins = options.origins ?? APNS_ORIGINS;
  return async ({ notification, response, destination, event, silent }) => {
    // Nothing was shown, so there is nothing to edit, recall or answer either.
    if (notification.priority <= -2) {
      return { kind: 'success', result: LOWEST_PRIORITY_RESULT };
    }
    if (
      !destination.apnsToken ||
      !destination.apnsEnvironment ||
      !destination.e2eKeyId ||
      !destination.e2eKeyCiphertext ||
      !destination.sessionId
    ) {
      return { kind: 'fail', error: 'Device destination is incomplete.' };
    }
    const session = await db.query.session.findFirst({
      where: { id: destination.sessionId },
      columns: { expiresAt: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      return {
        kind: 'fail',
        error: 'The device sign-in session ended; the device was removed.',
        destination: { remove: true },
      };
    }

    let credentials;
    try {
      credentials = getApnsCredentials();
    } catch (error) {
      return {
        kind: 'fail',
        error: `APNs is misconfigured: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    const key = credentials.keys[destination.apnsEnvironment];
    if (!credentials.teamId || !key) {
      return {
        kind: 'fail',
        error: `No APNs ${destination.apnsEnvironment} key is configured on this instance.`,
      };
    }

    const payload = buildEncryptedApnsPayload(
      decryptDeviceKey(destination.id, destination.e2eKeyCiphertext),
      destination.e2eKeyId,
      pushPlaintext(
        notification,
        event,
        getPlatformEnv().appUrl,
        response,
        silent,
      ),
      pushPriority(notification.priority),
    );
    let result: ApnsSendResult;
    try {
      result = await send({
        origin: origins[destination.apnsEnvironment],
        teamId: credentials.teamId,
        key,
        topic: credentials.topic,
        deviceToken: destination.apnsToken,
        payload,
        collapseId: notification.id,
        expiresAt: new Date(Date.now() + PUSH_EXPIRY_MS),
      });
    } catch (error) {
      return {
        kind: 'retry',
        error: `APNs request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (result.reason === 'ExpiredProviderToken') {
      invalidateProviderToken(credentials.teamId, key);
    }
    const outcome = classifyApnsResult(result);
    // The verdict is about the token we sent; the phone may have registered a
    // new one on this destination while the request was in flight.
    return outcome.destination
      ? {
          ...outcome,
          destination: {
            ...outcome.destination,
            ifApnsToken: destination.apnsToken,
          },
        }
      : outcome;
  };
}
