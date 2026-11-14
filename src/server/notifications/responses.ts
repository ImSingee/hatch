/**
 * Answers to notification reply forms.
 *
 * A notification takes one answer, from whoever answers first, and the answer
 * never changes. Answering bumps the notification's revision so phones that
 * show it replace it with the answered state, and queues one delivery of the
 * answer to every destination a response route selects.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db, schema, type TX } from '~/db';
import type { NotificationResponseVia } from '~/db/schema';
import { AppError } from '~server/errors';
import { publishPlatformEvent } from '~server/platform-events';
import {
  ReplyAnswerError,
  validateAnswers,
  type ReplyAnswers,
} from '../../../packages/hatch-platform-api/notification-reply';
import { wakeNotificationDispatcher } from './dispatcher';
import type { NotificationSource } from './ingest';
import { requeueDelivered } from './lifecycle';
import { decryptDeviceKey } from './secrets';

export type NotificationResponseView = {
  answers: ReplyAnswers;
  respondedBy: { userId: string | null; name: string };
  via: NotificationResponseVia;
  /** Device that answered from the push itself. */
  destinationId: string | null;
  respondedAt: string;
};

export function responseView(
  row: typeof schema.notificationResponses.$inferSelect,
): NotificationResponseView {
  return {
    answers: row.answers,
    respondedBy: { userId: row.respondedByUserId, name: row.respondedByName },
    via: row.via,
    destinationId: row.destinationId,
    respondedAt: row.createdAt.toISOString(),
  };
}

export async function loadResponseView(
  notificationId: string,
): Promise<NotificationResponseView | null> {
  const row = await db.query.notificationResponses.findFirst({
    where: { notificationId },
  });
  return row ? responseView(row) : null;
}

/** Someone answered first; carries their answer. */
export class AlreadyRespondedError extends AppError {
  readonly response: NotificationResponseView;

  constructor(response: NotificationResponseView) {
    super(
      `This notification was already answered by ${response.respondedBy.name}.`,
      409,
    );
    this.name = 'AlreadyRespondedError';
    this.response = response;
  }
}

type RoutedResponseTarget = {
  id: string;
  type: 'webhook' | 'app';
  name: string;
  routeIds: string[];
};

/**
 * Destinations that receive answers to a notification from `source` of
 * `kind`. Disabled routes and destinations never match, and an App
 * destination must still declare that it accepts responses.
 */
export async function resolveResponseTargets(
  tx: TX,
  source:
    | Pick<Extract<NotificationSource, { type: 'app' }>, 'type' | 'appId'>
    | Pick<
        Extract<NotificationSource, { type: 'channel' }>,
        'type' | 'channelId'
      >
    | { type: 'platform' },
  kind: string,
): Promise<RoutedResponseTarget[]> {
  if (source.type === 'platform') return [];
  const routes = (
    await tx.query.notificationResponseRoutes.findMany({
      where: { enabled: true },
    })
  ).filter((route) => {
    if (route.kind !== null && route.kind !== kind) return false;
    if (route.sourceType === 'any') return true;
    if (route.sourceType !== source.type) return false;
    if (source.type === 'app') {
      return route.appId === null || route.appId === source.appId;
    }
    return route.channelId === null || route.channelId === source.channelId;
  });
  if (routes.length === 0) return [];
  const routeIds = new Map<string, string[]>();
  for (const route of routes) {
    const list = routeIds.get(route.targetDestinationId) ?? [];
    list.push(route.id);
    routeIds.set(route.targetDestinationId, list);
  }
  const destinations = await tx.query.notificationDestinations.findMany({
    where: { id: { in: [...routeIds.keys()] }, enabled: true },
    columns: { id: true, type: true, name: true, acceptsResponses: true },
  });
  return destinations.flatMap((destination) =>
    destination.type === 'webhook' ||
    (destination.type === 'app' && destination.acceptsResponses)
      ? [
          {
            id: destination.id,
            type: destination.type,
            name: destination.name,
            routeIds: [...(routeIds.get(destination.id) ?? [])].sort(),
          },
        ]
      : [],
  );
}

export type Responder = {
  userId: string;
  via: NotificationResponseVia;
  /** Device that answered from the push. */
  destinationId?: string;
};

async function responderName(tx: TX, userId: string): Promise<string> {
  const user = await tx.query.user.findFirst({
    where: { id: userId },
    columns: { name: true, email: true },
  });
  return user?.name?.trim() || user?.email || 'Someone';
}

/**
 * Record the answer. Fails with 404 for a missing notification, 400 for a
 * notification without a form or answers that do not fit it, 409 when it
 * was recalled, and `AlreadyRespondedError` (409) when someone answered
 * first.
 */
export async function respondToNotification(
  notificationId: string,
  answers: unknown,
  responder: Responder,
): Promise<NotificationResponseView> {
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const [notification] = await tx
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notificationId))
      .for('update');
    if (!notification) throw new AppError('Notification not found.', 404);
    if (!notification.reply) {
      throw new AppError('This notification has no reply form.', 400);
    }
    if (notification.respondedAt) {
      const existing = await tx.query.notificationResponses.findFirst({
        where: { notificationId },
      });
      if (existing) throw new AlreadyRespondedError(responseView(existing));
    }
    if (notification.recalledAt) {
      throw new AppError('This notification was recalled.', 409);
    }
    let normalized: ReplyAnswers;
    try {
      normalized = validateAnswers(notification.reply, answers);
    } catch (error) {
      if (error instanceof ReplyAnswerError) {
        throw new AppError(error.message, 400);
      }
      throw error;
    }

    const [row] = await tx
      .insert(schema.notificationResponses)
      .values({
        notificationId,
        answers: normalized,
        respondedByUserId: responder.userId,
        respondedByName: await responderName(tx, responder.userId),
        via: responder.via,
        destinationId: responder.destinationId ?? null,
        createdAt: now,
      })
      .returning();
    await tx
      .update(schema.notifications)
      .set({
        respondedAt: now,
        revision: sql`${schema.notifications.revision} + 1`,
      })
      .where(eq(schema.notifications.id, notificationId));
    // Phones replace the shown notification with the answered one. Webhooks
    // and Apps learn of the answer only through response routes.
    await requeueDelivered(tx, notificationId, now, { devicesOnly: true });

    // Like routing, response routes apply to App and Channel notifications;
    // a member's direct notification keeps its answer in history only.
    const targets = await resolveResponseTargets(
      tx,
      notification.sourceType === 'app' && notification.appId
        ? { type: 'app', appId: notification.appId }
        : notification.sourceType === 'channel' && notification.channelId
          ? { type: 'channel', channelId: notification.channelId }
          : { type: 'platform' },
      notification.kind,
    );
    if (targets.length > 0) {
      await tx.insert(schema.notificationResponseDeliveries).values(
        targets.map((target) => ({
          notificationId,
          destinationId: target.id,
          destinationType: target.type,
          destinationName: target.name,
          routeIds: target.routeIds,
          nextAttemptAt: now,
        })),
      );
    }
    return responseView(row!);
  });
  publishPlatformEvent({ type: 'notification.updated', notificationId });
  wakeNotificationDispatcher();
  return outcome;
}

/** ================== answers signed by a device ================== */

export const DEVICE_KID_HEADER = 'x-hatch-kid';
export const DEVICE_RESPONSE_MAX_BYTES = 16 * 1024;
const DEVICE_RESPONSE_MAX_SKEW_MS = 5 * 60_000;
const DEVICE_RESPONSE_INFO = 'hatch-response-v1';

/** Key the phone derives from its push key to sign answers (HKDF-SHA256). */
export function deviceResponseKey(deviceKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', deviceKey, Buffer.alloc(0), DEVICE_RESPONSE_INFO, 32),
  );
}

/** Base64 HMAC-SHA256 over `hatch-response-v1|<timestamp>|<body>`. */
export function deviceResponseSignature(
  deviceKey: Buffer,
  timestamp: string,
  body: string,
): string {
  return createHmac('sha256', deviceResponseKey(deviceKey))
    .update(`${DEVICE_RESPONSE_INFO}|${timestamp}|${body}`)
    .digest('base64');
}

export class DeviceResponseError extends AppError {}

/**
 * Accept an answer a phone sends straight from the push, while the app may
 * be running in the background without the user's session. The phone signs
 * it with its push key; the answer counts as the device owner's and only for
 * notifications this device received.
 */
export async function respondFromDevice(args: {
  kid: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}): Promise<NotificationResponseView> {
  const { kid, timestamp, signature, body } = args;
  if (!kid || !timestamp || !signature) {
    throw new DeviceResponseError('Missing signature headers.', 401);
  }
  const sentAt = Number(timestamp);
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs((args.now ?? Date.now()) - sentAt) > DEVICE_RESPONSE_MAX_SKEW_MS
  ) {
    throw new DeviceResponseError('Signature timestamp is out of range.', 401);
  }
  const device = await db.query.notificationDestinations.findFirst({
    where: { type: 'device', e2eKeyId: kid },
  });
  if (!device?.e2eKeyCiphertext || !device.userId) {
    throw new DeviceResponseError('Unknown device.', 401);
  }
  const expected = Buffer.from(
    deviceResponseSignature(
      decryptDeviceKey(device.id, device.e2eKeyCiphertext),
      timestamp,
      body,
    ),
  );
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new DeviceResponseError('Invalid signature.', 401);
  }
  if (!device.enabled) {
    throw new DeviceResponseError('This device is turned off.', 403);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('Body must be JSON.', 400);
  }
  const notificationId =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { notificationId?: unknown }).notificationId
      : undefined;
  if (typeof notificationId !== 'string') {
    throw new AppError('notificationId is required.', 400);
  }
  // Only a notification this device received; anything else looks missing.
  const received = await db
    .select({ id: schema.notificationDeliveries.id })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.notificationId, notificationId),
        eq(schema.notificationDeliveries.destinationId, device.id),
        isNotNull(schema.notificationDeliveries.deliveredRevision),
        ne(schema.notificationDeliveries.status, 'canceled'),
      ),
    )
    .limit(1);
  if (received.length === 0) {
    throw new AppError('Notification not found.', 404);
  }
  return respondToNotification(
    notificationId,
    (parsed as { answers?: unknown }).answers,
    { userId: device.userId, via: 'push', destinationId: device.id },
  );
}

/** HTTP handling of `POST /api/notifications/device-response`. */
export async function handleDeviceResponse(
  request: Request,
): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > DEVICE_RESPONSE_MAX_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body) > DEVICE_RESPONSE_MAX_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }
  try {
    const response = await respondFromDevice({
      kid: request.headers.get(DEVICE_KID_HEADER),
      timestamp: request.headers.get('x-hatch-timestamp'),
      signature: request.headers.get('x-hatch-signature'),
      body,
    });
    return Response.json({ ok: true, response });
  } catch (error) {
    if (error instanceof AlreadyRespondedError) {
      return Response.json(
        {
          ok: false,
          error: { code: 'ALREADY_RESPONDED', message: error.message },
          response: error.response,
        },
        { status: 409 },
      );
    }
    if (error instanceof AppError) {
      return Response.json(
        {
          ok: false,
          error: {
            code:
              error.status === 409
                ? 'RECALLED'
                : error.status === 404
                  ? 'NOT_FOUND'
                  : error.status === 401 || error.status === 403
                    ? 'UNAUTHORIZED'
                    : 'BAD_REQUEST',
            message: error.message,
          },
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
