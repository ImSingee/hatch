// @ts-self-types="./notifications.d.ts"
/**
 * @hatch/app/notifications — push notifications from an App backend and
 * receive routed notifications when the App is a notification destination.
 */
import { hmacHeaders, runtimeEnv, verifyHmac } from './signing.js';

export type NotificationJson =
  | string
  | number
  | boolean
  | null
  | NotificationJson[]
  | { [key: string]: NotificationJson };

/** A notification of a kind declared in `notifications.kinds`. */
export type NotificationInput = {
  kind: string;
  title: string;
  body?: string;
  /**
   * Opened from the notification: any absolute URL a device can open, such as
   * a web page, another app by its scheme (`mailto:`, `slack://…`), or a Hatch
   * page by deep link (`hatch://app/<slug>#/route`, the instance web path
   * after `hatch://`), which phones open natively and the web opens on the
   * instance. `javascript:`, `data:`, `blob:`, `file:` and `about:` URLs are
   * rejected.
   */
  url?: string;
  /**
   * Whether tapping the notification on a phone opens `url` directly instead
   * of the notification's page in the Hatch app. Defaults to `true` when `url`
   * is set; pass `false` when the link is only a reference. `true` requires
   * `url`.
   */
  autoOpenUrl?: boolean;
  /** Extra structured data delivered to webhook and App destinations. */
  data?: { [key: string]: NotificationJson };
  /** Repeated pushes with the same key are stored once. */
  dedupeKey?: string;
  /** When the event happened; defaults to the time the platform accepts it. */
  occurredAt?: string | Date;
};

export type NotifyResult = { id: string; deduplicated: boolean };

export class NotificationError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'NotificationError';
    this.status = status;
  }
}

type RequestOptions = {
  url?: string;
  signingSecret?: string;
  signal?: AbortSignal;
};

async function postSigned<T>(
  path: '' | '/update' | '/recall',
  payload: unknown,
  options: RequestOptions,
): Promise<T> {
  const base = options.url ?? runtimeEnv('HATCH_NOTIFICATIONS_URL');
  const secret = options.signingSecret ?? runtimeEnv('HATCH_SIGNING_SECRET');
  if (!base || !secret) {
    throw new NotificationError(
      'Notifications are unavailable: enable capabilities.notifications and backend.',
      0,
    );
  }
  const body = JSON.stringify(payload);
  const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(await hmacHeaders(secret, body)),
    },
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new NotificationError(
      (await response.text()) ||
        `Notification request failed (${response.status})`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

/**
 * Push a notification to the platform. Uses the platform-injected
 * `HATCH_NOTIFICATIONS_URL` and `HATCH_SIGNING_SECRET` unless overridden.
 */
export async function notify(
  input: NotificationInput,
  options: RequestOptions = {},
): Promise<NotifyResult> {
  return postSigned<NotifyResult>(
    '',
    {
      ...input,
      occurredAt:
        input.occurredAt instanceof Date
          ? input.occurredAt.toISOString()
          : input.occurredAt,
    },
    options,
  );
}

/**
 * New content for a notification this App sent. Omitted fields keep their
 * value; `null` clears `body`, `url` or `data`. Without `autoOpenUrl`, adding
 * a `url` opens it on tap (as when pushing), clearing it turns that off, and
 * replacing it keeps the current setting.
 */
export type NotificationUpdateInput = {
  title?: string;
  body?: string | null;
  url?: string | null;
  autoOpenUrl?: boolean;
  data?: { [key: string]: NotificationJson } | null;
};

/**
 * `revision` increases with every edit and with the recall. `changed` is
 * false when the edit changed nothing or the notification was already
 * recalled; nothing is sent then.
 */
export type NotificationChangeResult = {
  id: string;
  revision: number;
  recalled: boolean;
  changed: boolean;
};

/**
 * Edit a notification this App sent (by the `id` from `notify`). Phones
 * replace it in place without alerting again; destinations that take edit
 * events receive `hatch.notification.updated`. A recalled notification
 * cannot be edited (409).
 */
export async function updateNotification(
  id: string,
  update: NotificationUpdateInput,
  options: RequestOptions = {},
): Promise<NotificationChangeResult> {
  return postSigned<NotificationChangeResult>(
    '/update',
    { ...update, id },
    options,
  );
}

/**
 * Recall a notification this App sent. Phones remove it, destinations that
 * never received it never will, and destinations that take recall events
 * receive `hatch.notification.recalled`. Recalling again changes nothing.
 */
export async function recallNotification(
  id: string,
  options: RequestOptions = {},
): Promise<NotificationChangeResult> {
  return postSigned<NotificationChangeResult>('/recall', { id }, options);
}

/**
 * Event types posted to `/__notification`. Edits and recalls arrive only when
 * the manifest sets `notifications.destination.lifecycleEvents`, and only for
 * notifications this App already received.
 */
export type HatchNotificationEventType =
  | 'hatch.notification'
  | 'hatch.notification.updated'
  | 'hatch.notification.recalled';

const EVENT_TYPES: readonly string[] = [
  'hatch.notification',
  'hatch.notification.updated',
  'hatch.notification.recalled',
];

/**
 * Envelope the platform POSTs to `/__notification` on App destinations.
 * Edits and recalls carry the notification's current state; `revision`
 * orders them and `(notification.id, revision)` identifies one event.
 */
export type HatchNotificationEnvelope = {
  type: HatchNotificationEventType;
  version: 1;
  deliveryId: string;
  /** 1-based; the same deliveryId may arrive again after a failed attempt. */
  attempt: number;
  revision: number;
  notification: {
    id: string;
    kind: string;
    kindName: string;
    title: string;
    body: string | null;
    url: string | null;
    /** Phone notifications open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    data: { [key: string]: NotificationJson } | null;
    dedupeKey: string | null;
    occurredAt: string;
    revision: number;
    editedAt: string | null;
    recalledAt: string | null;
    createdAt: string;
    source: {
      /** `user`: sent straight to this App by a person; id is the user id. */
      type: 'app' | 'channel' | 'platform' | 'user';
      id: string | null;
      slug: string | null;
      name: string;
    };
  };
};

export class NotificationVerificationError extends Error {
  constructor(message = 'Notification request is not signed by the platform.') {
    super(message);
    this.name = 'NotificationVerificationError';
  }
}

/**
 * Verify that a `/__notification` request was signed by the platform and
 * parse its envelope. Throws `NotificationVerificationError` otherwise; answer
 * such requests with 401 and never act on them.
 */
export async function verifyNotificationRequest(
  request: Request,
  options: { signingSecret?: string; maxSkewMs?: number } = {},
): Promise<HatchNotificationEnvelope> {
  const secret = options.signingSecret ?? runtimeEnv('HATCH_SIGNING_SECRET');
  if (!secret)
    throw new NotificationVerificationError('Missing signing secret.');
  const body = await request.text();
  const valid = await verifyHmac({
    secret,
    timestamp: request.headers.get('x-hatch-timestamp'),
    signature: request.headers.get('x-hatch-signature'),
    body,
    maxSkewMs: options.maxSkewMs ?? 5 * 60_000,
  });
  if (!valid) throw new NotificationVerificationError();
  const envelope = JSON.parse(body) as HatchNotificationEnvelope;
  if (!EVENT_TYPES.includes(envelope?.type)) {
    throw new NotificationVerificationError('Unexpected notification payload.');
  }
  return envelope;
}

/**
 * Successful `/__notification` response. `result` is a free-form note the
 * platform shows in the delivery history (e.g. "forwarded to Slack #ops").
 */
export function notificationResult(result?: string): Response {
  return Response.json(result === undefined ? {} : { result });
}
