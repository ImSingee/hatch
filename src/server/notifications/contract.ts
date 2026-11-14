/**
 * Wire contracts shared by notification ingress (App push, Channel push) and
 * outbound delivery (webhook and App destinations).
 */
import { z } from 'zod';
import {
  DEEP_LINK_SCHEME,
  DOCUMENT_URL_SCHEMES,
  parseHatchLink,
} from '../../../packages/hatch-platform-api/deep-link';
import {
  NOTIFICATION_KIND_RE,
  notificationKindSchema,
} from '../../../packages/hatch-manifest/src/app-schema.js';
import type {
  JsonObject,
  NotificationKindDeclaration,
  NotificationSourceType,
} from '~/db/schema';

export { NOTIFICATION_KIND_RE, notificationKindSchema };

/** Largest accepted push request body. */
export const MAX_NOTIFICATION_BODY_BYTES = 64 * 1024;
export const MAX_NOTIFICATION_TITLE = 200;
export const MAX_NOTIFICATION_TEXT = 4000;
export const MAX_NOTIFICATION_URL = 2048;
export const MAX_NOTIFICATION_DATA_BYTES = 32 * 1024;
export const MAX_NOTIFICATION_DEDUPE_KEY = 200;
/** App destination results are stored verbatim up to this many characters. */
export const MAX_DELIVERY_RESULT = 2000;
export const MAX_CHANNEL_KINDS = 100;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const urlField = z
  .string()
  .max(MAX_NOTIFICATION_URL)
  .nullish()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || isNotificationUrl(value), {
    message:
      'url must be an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link',
  });

const dataField = z
  .record(z.string(), z.json())
  .nullish()
  .transform((value) =>
    value && Object.keys(value).length > 0 ? (value as JsonObject) : null,
  )
  .refine(
    (value) =>
      value === null ||
      Buffer.byteLength(JSON.stringify(value)) <= MAX_NOTIFICATION_DATA_BYTES,
    {
      message: `data must serialize to at most ${MAX_NOTIFICATION_DATA_BYTES} bytes`,
    },
  );

/** Notification ids are lowercase ULIDs. */
const notificationIdField = z.string().regex(/^[0-9a-z]{26}$/, {
  message: 'id must be a notification id',
});

/** Body accepted from App backends and external Channel callers. */
export const notificationPushSchema = z
  .object({
    kind: z.string().regex(NOTIFICATION_KIND_RE, 'invalid notification kind'),
    title: z.string().trim().min(1).max(MAX_NOTIFICATION_TITLE),
    body: optionalText(MAX_NOTIFICATION_TEXT),
    url: urlField,
    /**
     * Tapping the phone push opens `url` instead of the notification. Defaults
     * to whether there is a `url`; `false` keeps the notification page.
     */
    autoOpenUrl: z.boolean().nullish(),
    data: dataField,
    dedupeKey: optionalText(MAX_NOTIFICATION_DEDUPE_KEY),
    occurredAt: z
      .string()
      .nullish()
      .transform((value) => (value ? value : null))
      .refine((value) => value === null || !Number.isNaN(Date.parse(value)), {
        message: 'occurredAt must be an ISO-8601 timestamp',
      }),
  })
  .strict()
  .superRefine((push, ctx) => {
    if (push.autoOpenUrl === true && !push.url) {
      ctx.addIssue({
        code: 'custom',
        message: 'autoOpenUrl requires url',
        path: ['autoOpenUrl'],
      });
    }
  })
  .transform((push) => ({
    ...push,
    autoOpenUrl: push.autoOpenUrl ?? push.url !== null,
  }));

export type NotificationPush = z.output<typeof notificationPushSchema>;

/**
 * Edit of a notification the caller sent. An omitted field keeps its value;
 * `null` (or an empty value) clears `body`, `url` and `data`. Without
 * `autoOpenUrl`, a new `url` opens on tap like a push, a cleared one stops and
 * a replaced one keeps the setting. `kind`,
 * `dedupeKey` and `occurredAt` never change. The id is part of the signed
 * body, so a replayed request can only repeat the same edit.
 */
export const notificationUpdateSchema = z
  .object({
    id: notificationIdField,
    title: z.string().trim().min(1).max(MAX_NOTIFICATION_TITLE).optional(),
    body: z
      .string()
      .max(MAX_NOTIFICATION_TEXT)
      .nullable()
      .transform((value) => value || null)
      .optional(),
    url: urlField.optional(),
    autoOpenUrl: z
      .boolean()
      .nullable()
      .transform((value) => value === true)
      .optional(),
    data: dataField.optional(),
  })
  .strict()
  .refine(
    (update) =>
      update.title !== undefined ||
      update.body !== undefined ||
      update.url !== undefined ||
      update.autoOpenUrl !== undefined ||
      update.data !== undefined,
    { message: 'update must change at least one field' },
  );

export type NotificationUpdate = z.output<typeof notificationUpdateSchema>;

/** Recall of a notification the caller sent. */
export const notificationRecallSchema = z
  .object({ id: notificationIdField })
  .strict();

/** Channel kind declarations: same shape and rules as App manifest kinds. */
export const channelKindsSchema = z
  .array(notificationKindSchema)
  .min(1)
  .max(MAX_CHANNEL_KINDS)
  .superRefine((kinds, ctx) => {
    const seen = new Set<string>();
    kinds.forEach((entry, index) => {
      if (seen.has(entry.kind)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate notification kind "${entry.kind}"`,
          path: [index, 'kind'],
        });
      }
      seen.add(entry.kind);
    });
  });

/**
 * A notification links to anything a device can open: a web page, another
 * app by its own scheme (`mailto:`, `tel:`, `someapp://…`), or a Hatch page by
 * deep link (`hatch://app/<slug>#/route`), which phones open natively and the
 * web opens on the instance. A `hatch:` link must name a page. Schemes that
 * only run inside the current document (`javascript:`, `data:`, …) open
 * nothing and are rejected. Development loopback instances are accepted in
 * deep links; the phone decides whether it may open them.
 */
export function isNotificationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (DOCUMENT_URL_SCHEMES.has(url.protocol)) return false;
  return (
    url.protocol !== `${DEEP_LINK_SCHEME}:` ||
    parseHatchLink(value, { allowLoopbackHttp: true }) !== null
  );
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function findKind(
  kinds: readonly NotificationKindDeclaration[] | undefined,
  kind: string,
): NotificationKindDeclaration | undefined {
  return kinds?.find((entry) => entry.kind === kind);
}

/** Stored notification projected for delivery envelopes and read APIs. */
export type NotificationRecord = {
  id: string;
  sourceType: NotificationSourceType;
  appId: string | null;
  channelId: string | null;
  userId: string | null;
  sourceName: string;
  kind: string;
  kindName: string;
  title: string;
  body: string | null;
  url: string | null;
  autoOpenUrl: boolean;
  data: JsonObject | null;
  dedupeKey: string | null;
  occurredAt: Date;
  revision: number;
  editedAt: Date | null;
  recalledAt: Date | null;
  createdAt: Date;
};

/**
 * What one delivery attempt tells a destination: the notification itself, or
 * a later edit or recall of a notification the destination already received.
 */
export type NotificationEvent = 'created' | 'updated' | 'recalled';

export const NOTIFICATION_EVENT_TYPES = {
  created: 'hatch.notification',
  updated: 'hatch.notification.updated',
  recalled: 'hatch.notification.recalled',
} as const satisfies Record<NotificationEvent, string>;

export type NotificationEventType =
  (typeof NOTIFICATION_EVENT_TYPES)[NotificationEvent];

/**
 * JSON body POSTed to webhook and App destinations. Edits and recalls carry
 * the notification's current state; `revision` orders them, and
 * `(notification.id, revision)` identifies one event.
 */
export type NotificationEnvelope = {
  type: NotificationEventType;
  version: 1;
  deliveryId: string;
  attempt: number;
  revision: number;
  notification: {
    id: string;
    kind: string;
    kindName: string;
    title: string;
    body: string | null;
    url: string | null;
    /** Phone pushes open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    data: JsonObject | null;
    dedupeKey: string | null;
    occurredAt: string;
    revision: number;
    editedAt: string | null;
    recalledAt: string | null;
    createdAt: string;
    source: {
      type: NotificationSourceType;
      id: string | null;
      slug: string | null;
      name: string;
    };
  };
};

/** The App, Channel or sending user id; null for platform notifications. */
export function notificationSourceId(
  notification: Pick<NotificationRecord, 'appId' | 'channelId' | 'userId'>,
): string | null {
  return notification.appId ?? notification.channelId ?? notification.userId;
}

export function buildEnvelope(args: {
  event: NotificationEvent;
  notification: NotificationRecord;
  deliveryId: string;
  attempt: number;
  sourceSlug: string | null;
}): NotificationEnvelope {
  const { notification } = args;
  return {
    type: NOTIFICATION_EVENT_TYPES[args.event],
    version: 1,
    deliveryId: args.deliveryId,
    attempt: args.attempt,
    revision: notification.revision,
    notification: {
      id: notification.id,
      kind: notification.kind,
      kindName: notification.kindName,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      autoOpenUrl: notification.autoOpenUrl,
      data: notification.data,
      dedupeKey: notification.dedupeKey,
      occurredAt: notification.occurredAt.toISOString(),
      revision: notification.revision,
      editedAt: notification.editedAt?.toISOString() ?? null,
      recalledAt: notification.recalledAt?.toISOString() ?? null,
      createdAt: notification.createdAt.toISOString(),
      source: {
        type: notification.sourceType,
        id: notificationSourceId(notification),
        slug: args.sourceSlug,
        name: notification.sourceName,
      },
    },
  };
}

/** Request headers carried by every outbound notification delivery. */
export const NOTIFICATION_ID_HEADER = 'x-hatch-notification-id';
export const NOTIFICATION_DELIVERY_HEADER = 'x-hatch-delivery-id';
/** The envelope `type`, so receivers can route before parsing the body. */
export const NOTIFICATION_EVENT_HEADER = 'x-hatch-event';
