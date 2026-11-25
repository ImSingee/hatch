/**
 * Wire contracts shared by notification ingress (App push, Channel push) and
 * outbound delivery (webhook and App destinations).
 */
import { z } from 'zod';
import { isNotificationUrl } from '../../../packages/hatch-platform-api/notification-url';
import {
  NOTIFICATION_KIND_RE,
  notificationKindSchema,
} from '../../../packages/hatch-manifest/src/app-schema.js';
import type {
  ReplyAnswers,
  ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import { optionalCardSchema } from '../../../packages/hatch-platform-api/notification-card-schema';
import type { NotificationCard } from '../../../packages/hatch-platform-api/notification-card';
import {
  describeIssue,
  optionalReplySchema,
} from '../../../packages/hatch-platform-api/notification-reply-schema';
import type {
  JsonObject,
  NotificationKindDeclaration,
  NotificationResponseVia,
  NotificationSourceType,
} from '~/db/schema';

export { NOTIFICATION_KIND_RE, notificationKindSchema, isNotificationUrl };

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

/**
 * Pushover-style priorities. Emergency (2, repeat until acknowledged) is not
 * supported.
 */
export const NOTIFICATION_PRIORITIES = [-2, -1, 0, 1] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];
export const DEFAULT_NOTIFICATION_PRIORITY = 0;

export function isNotificationPriority(
  value: unknown,
): value is NotificationPriority {
  return (
    typeof value === 'number' &&
    (NOTIFICATION_PRIORITIES as readonly number[]).includes(value)
  );
}

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

/**
 * -2 lowest: history and webhook/App destinations only, no phone push.
 * -1 low: delivered quietly (no sound, no banner, screen stays dark).
 * 0 normal (default). 1 high: time-sensitive, shown during Focus.
 */
const priorityField = z
  .number({ error: 'priority must be an integer from -2 to 1' })
  .nullish()
  .refine(
    (value) =>
      value === null || value === undefined || isNotificationPriority(value),
    {
      message:
        'priority must be an integer from -2 to 1 (emergency priority 2 is not supported)',
    },
  )
  .transform(
    (value) => (value ?? DEFAULT_NOTIFICATION_PRIORITY) as NotificationPriority,
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
     * to whether there is a `url` and no `reply` form to answer; `false` keeps
     * the notification page.
     */
    autoOpenUrl: z.boolean().nullish(),
    priority: priorityField,
    data: dataField,
    /** Form people answer once; the answer goes to response routes. */
    reply: optionalReplySchema.optional().transform((value) => value ?? null),
    /** Status and one block for the timeline; phones show title and body. */
    card: optionalCardSchema.optional().transform((value) => value ?? null),
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
    autoOpenUrl: push.autoOpenUrl ?? (push.url !== null && push.reply === null),
  }));

export type NotificationPush = z.output<typeof notificationPushSchema>;

/**
 * One-line reason a push body was rejected. Reply form issues name the
 * field to fix (`reply.fields.0.options: …`).
 */
export function pushIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid request';
  return issue.path[0] === 'reply' ? describeIssue(error) : issue.message;
}

/**
 * Edit of a notification the caller sent. An omitted field keeps its value;
 * `null` (or an empty value) clears `body`, `url` and `data`. Without
 * `autoOpenUrl`, a new `url` opens on tap like a push, a cleared one stops and
 * a replaced one keeps the setting. `reply` asks a new question: a form
 * replaces the current one and `null` removes it, either way starting the
 * next round, which takes its own answer. `kind`, `priority`, `dedupeKey`
 * and `occurredAt` never change. Updates alert again at the original
 * priority by default; `silent: true` only changes content. The id is part
 * of the signed body.
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
    /** A new question (starting the next round), or null to ask none. */
    reply: optionalReplySchema.optional(),
    /** A new card, or null to remove it. */
    card: optionalCardSchema.optional(),
    /** Only replace content without alerting again. Defaults to false. */
    silent: z.boolean().optional(),
  })
  .strict()
  .refine(
    (update) =>
      update.title !== undefined ||
      update.reply !== undefined ||
      update.card !== undefined ||
      update.body !== undefined ||
      update.url !== undefined ||
      update.autoOpenUrl !== undefined ||
      update.data !== undefined ||
      update.silent !== true,
    { message: 'a silent update must change at least one field' },
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
  priority: number;
  data: JsonObject | null;
  card: NotificationCard | null;
  dedupeKey: string | null;
  occurredAt: Date;
  revision: number;
  editedAt: Date | null;
  recalledAt: Date | null;
  reply: ReplyForm | null;
  /** Which question `reply` is; each round takes one answer. */
  replyRound: number;
  respondedAt: Date | null;
  /** Revision the latest answer created; null until answered. */
  responseRevision: number | null;
  createdAt: Date;
};

/** The answer to one round of a notification's reply form. */
export type NotificationResponseRecord = {
  round: number;
  /** The notification revision the answer created. */
  revision: number | null;
  answers: ReplyAnswers;
  respondedByUserId: string | null;
  respondedByName: string;
  via: NotificationResponseVia;
  createdAt: Date;
};

/**
 * What one delivery attempt tells a destination: the notification itself, a
 * later edit or recall of a notification the destination already received,
 * or (on response routes) the answer to its reply form.
 */
export type NotificationEvent =
  | 'created'
  | 'updated'
  | 'recalled'
  | 'responded';

export const NOTIFICATION_EVENT_TYPES = {
  created: 'hatch.notification',
  updated: 'hatch.notification.updated',
  recalled: 'hatch.notification.recalled',
  responded: 'hatch.notification.responded',
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
  /** Whether this delivery only changes state without another alert. */
  silent: boolean;
  notification: {
    id: string;
    kind: string;
    kindName: string;
    title: string;
    body: string | null;
    url: string | null;
    /** Phone pushes open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    /** -2 lowest, -1 low, 0 normal, 1 high. */
    priority: number;
    data: JsonObject | null;
    /** Status and one block the timeline shows; null without one. */
    card: NotificationCard | null;
    dedupeKey: string | null;
    occurredAt: string;
    revision: number;
    editedAt: string | null;
    recalledAt: string | null;
    /** The form to answer, or null. */
    reply: ReplyForm | null;
    /**
     * The answer, only in `hatch.notification.responded`: destinations get
     * answers solely through response routes.
     */
    response: NotificationResponseEnvelope | null;
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

export type NotificationResponseEnvelope = {
  /**
   * The round of the reply form this answers: 1 for the form the
   * notification was sent with, one more for each new question an edit asked.
   * `(notification.id, round)` identifies one answer.
   */
  round: number;
  answers: ReplyAnswers;
  respondedBy: { userId: string | null; name: string };
  /** Where it was answered: `push`, `mobile`, `web` or `cli`. */
  via: NotificationResponseVia;
  respondedAt: string;
};

export function responseEnvelope(
  response: NotificationResponseRecord,
): NotificationResponseEnvelope {
  return {
    round: response.round,
    answers: response.answers,
    respondedBy: {
      userId: response.respondedByUserId,
      name: response.respondedByName,
    },
    via: response.via,
    respondedAt: response.createdAt.toISOString(),
  };
}

/**
 * The revision of the notification's own content (send, edits, recall). The
 * revision an answer creates belongs to its `responded` event alone, so no
 * other event ever carries it. Answers happen once and add exactly one, so
 * when the answer is the latest change the content revision is the one
 * before it.
 */
export function contentRevision(
  notification: Pick<NotificationRecord, 'revision' | 'responseRevision'>,
): number {
  return notification.responseRevision === notification.revision
    ? notification.revision - 1
    : notification.revision;
}

export function buildEnvelope(args: {
  event: NotificationEvent;
  notification: NotificationRecord;
  response: NotificationResponseRecord | null;
  deliveryId: string;
  attempt: number;
  sourceSlug: string | null;
  silent?: boolean;
}): NotificationEnvelope {
  const { notification } = args;
  return {
    type: NOTIFICATION_EVENT_TYPES[args.event],
    version: 1,
    deliveryId: args.deliveryId,
    attempt: args.attempt,
    // `(notification.id, revision)` identifies one event. The answer keeps
    // the revision it created on every attempt, whatever happens to the
    // notification later; every other event uses the content revision.
    revision:
      args.event === 'responded'
        ? (args.response?.revision ??
          notification.responseRevision ??
          contentRevision(notification))
        : contentRevision(notification),
    silent:
      args.event === 'recalled' ||
      args.event === 'responded' ||
      args.silent === true,
    notification: {
      id: notification.id,
      kind: notification.kind,
      kindName: notification.kindName,
      title: notification.title,
      body: notification.body,
      url: notification.url,
      autoOpenUrl: notification.autoOpenUrl,
      priority: notification.priority,
      data: notification.data,
      card: notification.card,
      dedupeKey: notification.dedupeKey,
      occurredAt: notification.occurredAt.toISOString(),
      revision: contentRevision(notification),
      editedAt: notification.editedAt?.toISOString() ?? null,
      recalledAt: notification.recalledAt?.toISOString() ?? null,
      reply: notification.reply,
      response: args.response ? responseEnvelope(args.response) : null,
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
