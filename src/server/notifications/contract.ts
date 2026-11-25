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
  notificationHeadline,
  summaryFromTitle,
  type ContentNode,
  type NotificationFormat,
} from '../../../packages/hatch-platform-api/notification-content';
import {
  legacyCardPreview,
  legacyToContent,
} from '../../../packages/hatch-platform-api/notification-content-legacy';
import { contentToPlainText } from '../../../packages/hatch-platform-api/notification-content-text';
import {
  ContentError,
  compileCard,
  compileMarkdown,
  isLegacyCardInput,
  optionalSummarySchema,
  type CompiledCard,
} from '../../../packages/hatch-platform-api/notification-content-schema';
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

/** What a notification shows, as stored (see the content check in schema). */
export type NotificationContentFields = {
  format: NotificationFormat;
  /** Text notifications only. */
  title: string | null;
  body: string | null;
  /** Optional for text, always set for markdown and card. */
  summary: string | null;
  /** The Markdown source of a markdown notification. */
  markdown: string | null;
  /** The render tree of a markdown or card notification. */
  content: ContentNode | null;
};

const SUMMARY_REQUIRED =
  'summary is required for markdown and card notifications';
const ONE_CONTENT =
  'set only one content: title (with an optional body), markdown or card';
const INLINE_REPLY = 'cannot be combined with inputs written in the card';

/** `null`, `undefined` and `""` all mean "not given". */
const isUnset = (value: unknown) =>
  value === null || value === undefined || value === '';

/** Empty spellings of a card: no card. */
const isEmptyCard = (value: unknown) =>
  isUnset(value) ||
  (typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0);

const titleText = z
  .string({ error: 'title must be a string' })
  .trim()
  .min(1, 'title must not be empty')
  .max(
    MAX_NOTIFICATION_TITLE,
    `title must be at most ${MAX_NOTIFICATION_TITLE} characters`,
  );

/** A title, where `null` and `""` mean none. */
const optionalTitle = z.preprocess(
  (value) => (isUnset(value) ? undefined : value),
  titleText.optional(),
);

const markdownText = z.preprocess(
  (value) => (isUnset(value) ? undefined : value),
  z.string({ error: 'markdown must be a string' }).optional(),
);

type ParsedCard =
  | { kind: 'none' }
  /** The #319 `{ status, block }` shape; null when it normalizes to nothing. */
  | { kind: 'legacy'; card: NotificationCard | null }
  | { kind: 'card'; compiled: CompiledCard };

function issue(ctx: z.RefinementCtx, path: string, message: string) {
  ctx.addIssue({ code: 'custom', message, path: [path] });
}

/** Card markup, a JSON tree or the #319 shape; issues go to `card`. */
function parseCard(value: unknown, ctx: z.RefinementCtx): ParsedCard | null {
  if (isEmptyCard(value)) return { kind: 'none' };
  if (isLegacyCardInput(value)) {
    const legacy = optionalCardSchema.safeParse(value);
    if (!legacy.success) {
      issue(ctx, 'card', describeIssue(legacy.error, 'card'));
      return null;
    }
    return { kind: 'legacy', card: legacy.data };
  }
  try {
    return { kind: 'card', compiled: compileCard(value) };
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    issue(ctx, 'card', `card: ${error.message}`);
    return null;
  }
}

function parseMarkdown(
  source: string,
  ctx: z.RefinementCtx,
): ContentNode | null {
  try {
    return compileMarkdown(source);
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    issue(ctx, 'markdown', `markdown: ${error.message}`);
    return null;
  }
}

/** Body accepted from App backends and external Channel callers. */
const notificationPushInput = z
  .object({
    kind: z.string().regex(NOTIFICATION_KIND_RE, 'invalid notification kind'),
    /**
     * The content is one of: `title` (with an optional `body`), `markdown`,
     * or `card` (markup, a JSON tree, or the #319 `{ status, block }` shape
     * together with `title` and `body`).
     */
    title: optionalTitle,
    body: optionalText(MAX_NOTIFICATION_TEXT),
    markdown: markdownText,
    card: z.unknown().optional(),
    /** One plain line for push and lists; required for markdown and card. */
    summary: optionalSummarySchema.optional(),
    url: urlField,
    /**
     * Tapping the phone push opens `url` instead of the notification. Defaults
     * to whether there is a `url` and no `reply` form to answer; `false` keeps
     * the notification page.
     */
    autoOpenUrl: z.boolean().nullish(),
    priority: priorityField,
    data: dataField,
    /**
     * Form people answer once; the answer goes to response routes. A card
     * may write its inputs inline instead.
     */
    reply: optionalReplySchema.optional().transform((value) => value ?? null),
    dedupeKey: optionalText(MAX_NOTIFICATION_DEDUPE_KEY),
    occurredAt: z
      .string()
      .nullish()
      .transform((value) => (value ? value : null))
      .refine((value) => value === null || !Number.isNaN(Date.parse(value)), {
        message: 'occurredAt must be an ISO-8601 timestamp',
      }),
  })
  .strict();

export const notificationPushSchema = notificationPushInput.transform(
  (push, ctx) => {
    const {
      title,
      body,
      markdown,
      card: cardInput,
      summary: givenSummary,
      reply: givenReply,
      autoOpenUrl,
      ...rest
    } = push;
    const card = parseCard(cardInput, ctx);
    const content =
      markdown === undefined ? null : parseMarkdown(markdown, ctx);
    if (!card || (markdown !== undefined && !content)) return z.NEVER;
    const legacy = card.kind === 'legacy';
    const given = [
      title !== undefined || legacy,
      markdown !== undefined,
      card.kind === 'card',
    ].filter(Boolean).length;
    if (given === 0) {
      issue(
        ctx,
        'title',
        'set the content: title (with an optional body), markdown or card',
      );
      return z.NEVER;
    }
    if (given > 1) {
      issue(ctx, 'title', ONE_CONTENT);
      return z.NEVER;
    }
    if (legacy && title === undefined) {
      issue(
        ctx,
        'title',
        'a card in the { status, block } shape needs a title',
      );
      return z.NEVER;
    }
    if (body !== null && title === undefined) {
      issue(
        ctx,
        'body',
        'body goes with title; markdown and card notifications have no body',
      );
      return z.NEVER;
    }
    const summary = givenSummary ?? null;
    let fields: NotificationContentFields;
    let reply = givenReply;
    if (title !== undefined) {
      fields =
        card.kind === 'legacy' && card.card
          ? {
              format: 'card',
              title: null,
              body: null,
              summary: summary ?? summaryFromTitle(title),
              markdown: null,
              content: legacyToContent({ title, body, card: card.card }),
            }
          : {
              format: 'text',
              title,
              body,
              summary,
              markdown: null,
              content: null,
            };
    } else {
      if (summary === null) {
        issue(ctx, 'summary', SUMMARY_REQUIRED);
        return z.NEVER;
      }
      if (card.kind === 'card') {
        if (card.compiled.reply && givenReply) {
          issue(ctx, 'reply', INLINE_REPLY);
          return z.NEVER;
        }
        reply = card.compiled.reply ?? givenReply;
        fields = {
          format: 'card',
          title: null,
          body: null,
          summary,
          markdown: null,
          content: card.compiled.content,
        };
      } else {
        fields = {
          format: 'markdown',
          title: null,
          body: null,
          summary,
          markdown: markdown!,
          content,
        };
      }
    }
    if (autoOpenUrl === true && !rest.url) {
      issue(ctx, 'autoOpenUrl', 'autoOpenUrl requires url');
      return z.NEVER;
    }
    return {
      ...rest,
      ...fields,
      reply,
      autoOpenUrl: autoOpenUrl ?? (rest.url !== null && reply === null),
    };
  },
);

export type NotificationPush = z.output<typeof notificationPushSchema>;

/**
 * One-line reason a push body was rejected. Reply form issues name the
 * field to fix (`reply.fields.0.options: …`); content issues keep the
 * position the parser reported (`card: 3:5: …`).
 */
export function pushIssueMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid request';
  return first.path[0] === 'reply' ? describeIssue(error) : first.message;
}

/** New Markdown or card content an edit switches to. */
export type NotificationContentReplacement =
  | {
      format: 'markdown';
      markdown: string;
      content: ContentNode;
      /** Inline inputs never come from Markdown. */
      reply: null;
    }
  | {
      format: 'card';
      markdown: null;
      content: ContentNode;
      /** The form the card's inline inputs make; null without inputs. */
      reply: ReplyForm | null;
    };

/**
 * Edit of a notification the caller sent. An omitted field keeps its value;
 * `null` (or an empty value) clears `body`, `url`, `data` and `summary`.
 * Without `autoOpenUrl`, a new `url` opens on tap like a push, a cleared one
 * stops and a replaced one keeps the setting. `reply` asks a new question: a
 * form replaces the current one and `null` removes it, either way starting
 * the next round, which takes its own answer. `kind`, `priority`, `dedupeKey`
 * and `occurredAt` never change. Updates alert again at the original
 * priority by default; `silent: true` only changes content. The id is part
 * of the signed body.
 *
 * Content: `markdown` or a `card` in markup or as a tree switches to that
 * format (keeping the summary unless one is given). `title`, `body` and a
 * #319 `{ status, block }` card (or `card: null`) edit a text notification
 * or a card sent in that shape; on any other notification they switch it to
 * text and need a `title`. See `resolveContentUpdate`.
 */
export const notificationUpdateSchema = z
  .object({
    id: notificationIdField,
    title: z.preprocess(
      (value) => (value === null ? undefined : value),
      titleText.optional(),
    ),
    body: z
      .string()
      .max(MAX_NOTIFICATION_TEXT)
      .nullable()
      .transform((value) => value || null)
      .optional(),
    markdown: markdownText,
    /** Markup, a JSON tree, the #319 shape, or null to remove a #319 card. */
    card: z.unknown().optional(),
    /** A new summary, or null to remove a text notification's summary. */
    summary: optionalSummarySchema.optional(),
    url: urlField.optional(),
    autoOpenUrl: z
      .boolean()
      .nullable()
      .transform((value) => value === true)
      .optional(),
    data: dataField.optional(),
    /** A new question (starting the next round), or null to ask none. */
    reply: optionalReplySchema.optional(),
    /** Only replace content without alerting again. Defaults to false. */
    silent: z.boolean().optional(),
  })
  .strict()
  .transform((update, ctx) => {
    const { markdown, card: cardInput, ...rest } = update;
    const card =
      cardInput === undefined
        ? ({ kind: 'none' } as const)
        : cardInput === null || isEmptyCard(cardInput)
          ? ({ kind: 'legacy', card: null } as const)
          : parseCard(cardInput, ctx);
    const markdownContent =
      markdown === undefined ? null : parseMarkdown(markdown, ctx);
    if (!card || (markdown !== undefined && !markdownContent)) return z.NEVER;
    const textEdit =
      update.title !== undefined ||
      update.body !== undefined ||
      card.kind === 'legacy';
    if (
      [textEdit, markdown !== undefined, card.kind === 'card'].filter(Boolean)
        .length > 1
    ) {
      issue(ctx, 'title', ONE_CONTENT);
      return z.NEVER;
    }
    let content: NotificationContentReplacement | undefined;
    if (markdownContent) {
      content = {
        format: 'markdown',
        markdown: markdown!,
        content: markdownContent,
        reply: null,
      };
    } else if (card.kind === 'card') {
      if (card.compiled.reply && update.reply !== undefined) {
        issue(ctx, 'reply', INLINE_REPLY);
        return z.NEVER;
      }
      content = {
        format: 'card',
        markdown: null,
        content: card.compiled.content,
        reply: card.compiled.reply,
      };
    }
    const result = {
      ...rest,
      ...(content ? { content } : {}),
      ...(card.kind === 'legacy' ? { legacyCard: card.card } : {}),
    };
    if (
      result.silent === true &&
      Object.entries(result).every(
        ([key, value]) =>
          key === 'id' || key === 'silent' || value === undefined,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'a silent update must change at least one field',
        path: [],
      });
      return z.NEVER;
    }
    return result;
  });

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
export type NotificationRecord = NotificationContentFields & {
  id: string;
  sourceType: NotificationSourceType;
  appId: string | null;
  channelId: string | null;
  userId: string | null;
  sourceName: string;
  kind: string;
  kindName: string;
  url: string | null;
  autoOpenUrl: boolean;
  priority: number;
  data: JsonObject | null;
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
    /**
     * What names it: the title of a text notification, the summary of a
     * markdown or card one. Always a string.
     */
    title: string;
    /** A text notification's body, or the content as plain text. */
    body: string | null;
    /** `text`, `markdown` or `card`. */
    format: NotificationFormat;
    /** One plain line; always set for markdown and card. */
    summary: string | null;
    /** The Markdown source of a markdown notification. */
    markdown: string | null;
    /** The render tree of a markdown or card notification. */
    content: ContentNode | null;
    url: string | null;
    /** Phone pushes open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    /** -2 lowest, -1 low, 0 normal, 1 high. */
    priority: number;
    data: JsonObject | null;
    /**
     * For receivers built before `format`: a card's status and first
     * progress, stats or quote block in the #319 shape; null otherwise.
     */
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

/**
 * A text notification's body, or a markdown or card notification's content
 * as plain text: what channels that only show text show below the headline.
 */
export function notificationText(
  notification: Pick<NotificationContentFields, 'format' | 'body' | 'content'>,
): string | null {
  if (notification.format === 'text' || !notification.content) {
    return notification.body;
  }
  return contentToPlainText(notification.content) || null;
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
      title: notificationHeadline(notification),
      body: notificationText(notification),
      format: notification.format,
      summary: notification.summary,
      markdown: notification.markdown,
      content: notification.content,
      url: notification.url,
      autoOpenUrl: notification.autoOpenUrl,
      priority: notification.priority,
      data: notification.data,
      card:
        notification.format === 'card'
          ? legacyCardPreview(notification.content)
          : null,
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
