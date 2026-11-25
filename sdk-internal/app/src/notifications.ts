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

/** One choice of a `buttons`, `single` or `multiple` field. */
export type NotificationReplyOption = {
  /** 1-40 lowercase letters, digits, `_`, `-` or `.`; unique in the field. */
  id: string;
  label: string;
  /** `buttons` only: shown as a destructive action. */
  destructive?: boolean;
  /** `buttons` only: the main action. */
  primary?: boolean;
  /** `single` and `multiple` only: shown beside the label, such as "1 min" (at most 40 characters). */
  note?: string;
  /** `single` and `multiple` only: a small tag, such as "breaking" (at most 16 characters). */
  badge?: string;
};

/**
 * One question of a reply form. `buttons` is a single choice shown as
 * buttons (1-4 options, labels up to 32 characters); `single` and `multiple`
 * take 2-50 options; `text` takes free text.
 */
export type NotificationReplyField = {
  /** Starts with a lowercase letter; lowercase letters, digits and `_`. */
  id: string;
  type: 'buttons' | 'single' | 'multiple' | 'text';
  label: string;
  description?: string;
  /** Defaults to `true`. */
  required?: boolean;
  /** Choice fields only. */
  options?: NotificationReplyOption[];
  /** `multiple` only; defaults to 1. */
  minSelected?: number;
  /** `multiple` only; defaults to the number of options. */
  maxSelected?: number;
  /** `text` only. */
  placeholder?: string;
  /** `text` only. */
  multiline?: boolean;
  /** `text` only; defaults to 1000, at most 4000. */
  maxLength?: number;
  /**
   * Chosen to begin with: an option id for `single`, option ids for
   * `multiple`.
   */
  default?: string | string[];
};

/**
 * A form people answer once, on the phone (from the push itself when the
 * form is one required `buttons` or `text` field) or on the web. The answer
 * goes to the destinations of matching response routes.
 */
export type NotificationReplyInput = {
  /** 1-10 fields. */
  fields: NotificationReplyField[];
  /** Defaults to "Submit". */
  submitLabel?: string;
};

/** A reply form as delivered: every default is filled in. */
export type NotificationReply = {
  fields: (Required<
    Pick<NotificationReplyField, 'id' | 'type' | 'label' | 'required'>
  > &
    Omit<NotificationReplyField, 'id' | 'type' | 'label' | 'required'>)[];
  submitLabel: string;
};

/**
 * Answers keyed by field id: the option id of a `buttons` or `single`
 * field, the option ids of a `multiple` field, the text of a `text` field.
 * Unanswered optional fields are absent.
 */
export type NotificationAnswers = { [fieldId: string]: string | string[] };

export type NotificationResponse = {
  /**
   * The round of the reply form this answers: 1 for the form it was sent
   * with, one more for each new question an edit asked. A notification takes
   * one answer per round, so `(notification.id, round)` identifies an answer.
   */
  round: number;
  answers: NotificationAnswers;
  respondedBy: { userId: string | null; name: string };
  /** Where it was answered. */
  via: 'push' | 'mobile' | 'web' | 'cli';
  respondedAt: string;
};

/** `-2` lowest, `-1` low, `0` normal, `1` high. */
export type NotificationPriority = -2 | -1 | 0 | 1;

/** How a notification's content is written. */
export type NotificationFormat = 'text' | 'markdown' | 'card';

/**
 * A node of the render tree that Markdown and card markup compile into, and
 * the JSON form a card may be sent in: `{ type, props?, children? }` with
 * strings as text leaves. Components are capitalized (`Card`, `Steps`),
 * inline marks lowercase (`b`, `a`). A card's root is `{ type: 'Card' }`.
 * Text in a tree is never read as markup.
 */
export type NotificationContentNode = {
  type: string;
  props?: { [name: string]: string | number | boolean | number[] };
  children?: (NotificationContentNode | string)[];
};

/**
 * The card shape of older Apps: a short status with a tone and at most one
 * block, shown with the title and body.
 *
 * @deprecated Write the card as markup (see `card`) or as a
 * `NotificationContentNode` tree, with a `summary`. This shape is still
 * accepted (with `title`) and becomes a card notification whose summary is
 * the title.
 */
export type NotificationCard = {
  /** At most 24 characters, such as "CI failed". Tone defaults to neutral. */
  status?: {
    label: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  };
  block?:
    | {
        /** A bar filled to `percent` (0-100), with an optional "3 / 14". */
        type: 'progress';
        label: string;
        percent: number;
        value?: string;
      }
    | {
        /** One to three figures side by side. */
        type: 'stats';
        items: { value: string; label: string }[];
      }
    | {
        /** A comment someone made, such as a review note. */
        type: 'quote';
        author: string;
        text: string;
        location?: string;
      };
};

type NotificationInputBase = {
  /** A kind declared in `notifications.kinds`. */
  kind: string;
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
   * is set and there is no `reply` form; pass `false` when the link is only a
   * reference. `true` requires `url`.
   */
  autoOpenUrl?: boolean;
  /**
   * Pushover-style priority, default `0`. `-2` lowest: kept in history and
   * sent to webhook and App destinations, never pushed to phones. `-1` low:
   * phones receive it quietly (no sound, no banner). `0` normal. `1` high:
   * time-sensitive, shown on phones during Focus and Do Not Disturb. It never
   * changes after the push.
   */
  priority?: NotificationPriority;
  /** Extra structured data delivered to webhook and App destinations. */
  data?: { [key: string]: NotificationJson };
  /**
   * Ask people to answer: one answer, from whoever answers first. Ask a later
   * question with `updateNotification(id, { reply })`. A card with inline
   * inputs (`<Choice>`, `<Buttons>`, `<Input>`) makes its own form and cannot
   * also take `reply` (400).
   */
  reply?: NotificationReplyInput;
  /** Repeated pushes with the same key are stored once. */
  dedupeKey?: string;
  /** When the event happened; defaults to the time the platform accepts it. */
  occurredAt?: string | Date;
};

/** A text notification: a title and an optional plain-text body. */
export type NotificationTextInput = NotificationInputBase & {
  /** At most 200 characters. */
  title: string;
  body?: string;
  /**
   * One plain line (at most 200 characters, no line breaks) that phone
   * pushes show under the title instead of the body. Optional for text.
   */
  summary?: string;
  /**
   * @deprecated The status-and-block card of older Apps; write a card
   * notification (`card` markup or a tree, with `summary`) instead.
   */
  card?: NotificationCard;
  markdown?: never;
};

/**
 * A Markdown notification: headings, emphasis, lists, quotes, code, links
 * and tables, at most 16 KiB. It has no title or body; its content carries
 * its own heading.
 */
export type NotificationMarkdownInput = NotificationInputBase & {
  markdown: string;
  /**
   * Required: one plain line (at most 200 characters, no line breaks) for
   * phone pushes, lists and other places that show text only.
   */
  summary: string;
  title?: never;
  body?: never;
  card?: never;
};

/**
 * A card notification, composed from the card components: markup such as
 * `<Card status="CI failed" tone="danger"><Title>…</Title></Card>` (build
 * it with the `card` tag, which escapes interpolated values) or a
 * `NotificationContentNode` tree rooted at `{ type: 'Card' }`, at most
 * 16 KiB. It has no title or body. `hatch notification card catalog`
 * lists the components and `hatch notification card check` checks a card.
 */
export type NotificationCardInput = NotificationInputBase & {
  card: string | NotificationContentNode;
  /**
   * Required: one plain line (at most 200 characters, no line breaks) for
   * phone pushes, lists and other places that show text only.
   */
  summary: string;
  title?: never;
  body?: never;
  markdown?: never;
};

/**
 * A notification of a kind declared in `notifications.kinds`: exactly one
 * of text (`title`, `body`), `markdown` or a `card`. Markdown and card
 * notifications need a `summary`.
 */
export type NotificationInput =
  | NotificationTextInput
  | NotificationMarkdownInput
  | NotificationCardInput;

/**
 * Markup made by `cardFragment`: interpolated into `card` (or another
 * fragment) as markup rather than as text.
 */
export class CardFragment {
  readonly markup: string;

  constructor(markup: string) {
    this.markup = markup;
  }

  toString(): string {
    return this.markup;
  }
}

function escapeCardText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cardScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return escapeCardText(value);
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(
    'card: interpolate strings, numbers, booleans, dates, arrays of them, or cardFragment results',
  );
}

function cardValue(value: unknown): string {
  if (value instanceof CardFragment) return value.markup;
  if (!Array.isArray(value)) return cardScalar(value);
  const fragments = value.filter((item) => item instanceof CardFragment);
  if (fragments.length === 0) return value.map(cardScalar).join(',');
  if (fragments.length !== value.length) {
    throw new TypeError(
      'card: an array mixes cardFragment results with plain values',
    );
  }
  return fragments.map((fragment) => fragment.markup).join('');
}

function cardMarkup(
  strings: TemplateStringsArray,
  values: readonly unknown[],
): string {
  let markup = strings[0] ?? '';
  values.forEach((value, index) => {
    markup += cardValue(value) + (strings[index + 1] ?? '');
  });
  return markup;
}

/**
 * Card markup from a template, with every interpolated value escaped
 * (`&`, `<`, `>`, `"` and `'`) so user text can never add or change
 * elements:
 *
 * ```ts
 * await notify({
 *   kind: 'build',
 *   summary: `${branch} failed`,
 *   card: card`<Card status="CI failed" tone="danger">
 *     <Title>${title}</Title>
 *     <Steps>${steps.map((step) => cardFragment`<Step state="${step.state}">${step.name}</Step>`)}</Steps>
 *   </Card>`,
 * });
 * ```
 *
 * Interpolate only into text and quoted attribute values, never into a tag
 * or attribute name. Strings are escaped; numbers, booleans and bigints are
 * written as is; dates as ISO-8601 (for `<time datetime>`); `null` and
 * `undefined` as nothing, so an empty attribute such as `status=""` is left
 * out. An array of plain values becomes a comma-separated list (the form
 * `<Trend values>` takes); an array of `cardFragment` results is joined as
 * markup, to repeat elements. Other objects throw a `TypeError`. Returns the
 * markup string; the platform checks it when the notification is sent.
 */
export function card(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return cardMarkup(strings, values);
}

/**
 * A piece of card markup for `card`, escaped like `card`, such as one
 * `<Step>` per item of a list: interpolate the fragment (or an array of
 * them) into `card` and it is kept as markup.
 */
export function cardFragment(
  strings: TemplateStringsArray,
  ...values: unknown[]
): CardFragment {
  return new CardFragment(cardMarkup(strings, values));
}

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
 * value; `null` clears `body`, `url`, `data` or a text notification's
 * `summary`. `markdown` or a `card` (markup or a tree) replaces the whole
 * content and switches to that format; the current summary carries over
 * unless `summary` gives a new one, and a notification without one needs
 * it (400). They cannot be combined with `title` or `body`, which switch a
 * Markdown or card notification back to text (then `title` is required). Without `autoOpenUrl`, adding
 * a `url` opens it on tap (as when pushing), clearing it turns that off, and
 * replacing it keeps the current setting. `reply` asks a new question: a
 * form replaces the current one and `null` removes it, either way starting
 * the next round, which takes its own answer (`response.round`). Forms are
 * compared by content: sending the same form again (even with a new title or
 * `data`) starts no round, and once the round is answered such a `data`
 * change fails with 409. To ask the same question again about something new,
 * change the form too (for example its field label or `submitLabel`).
 */
export type NotificationUpdateInput = {
  /** Only change content, without another alert. Defaults to false. */
  silent?: boolean;
  title?: string;
  body?: string | null;
  /**
   * One plain line (at most 200 characters, no line breaks) for pushes and
   * lists; `null` removes a text notification's summary. Markdown and card
   * notifications always keep one.
   */
  summary?: string | null;
  /** New Markdown content. */
  markdown?: string;
  autoOpenUrl?: boolean;
  data?: { [key: string]: NotificationJson } | null;
  reply?: NotificationReplyInput | null;
  /**
   * New card content: markup (see `card`) or a `NotificationContentNode`
   * tree. A card with inline inputs asks a new question with the form they
   * make; content without them removes such a form. The deprecated
   * status-and-block `NotificationCard` replaces the card of an older-style
   * notification, and `null` removes that card, leaving text.
   */
  card?: string | NotificationContentNode | NotificationCard | null;
};

/**
 * `revision` increases with every edit and with the recall. `changed` is
 * false when a silent edit changed nothing or the notification was already
 * recalled; nothing is sent then. An alerting update always advances it.
 */
export type NotificationChangeResult = {
  id: string;
  revision: number;
  recalled: boolean;
  changed: boolean;
};

/**
 * Edit a notification this App sent (by the `id` from `notify`). Phones
 * replace it in place and alert again at its original priority, even with
 * unchanged content. Pass `silent: true` to only change content; `{}` repeats
 * the alert. Destinations that take edit events receive
 * `hatch.notification.updated`. A recalled notification cannot be edited
 * (409), and an answered one cannot change its `data` (409), which its answer
 * is delivered with, unless the same edit asks a new question.
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
 * notifications this App already received. Answers to reply forms
 * (`hatch.notification.responded`) arrive only when the manifest sets
 * `notifications.destination.responses` and a response route selects the
 * App; `notification.response` then holds the answer.
 */
export type HatchNotificationEventType =
  | 'hatch.notification'
  | 'hatch.notification.updated'
  | 'hatch.notification.recalled'
  | 'hatch.notification.responded';

const EVENT_TYPES: readonly string[] = [
  'hatch.notification',
  'hatch.notification.updated',
  'hatch.notification.recalled',
  'hatch.notification.responded',
];

/**
 * Envelope the platform POSTs to `/__notification` on App destinations.
 * Edits and recalls carry the notification's current state; `revision`
 * orders them and `(notification.id, revision)` identifies one event. For
 * `hatch.notification.responded`, `revision` is the revision the answer
 * created, even when the notification changed after it; no other event
 * carries that revision.
 */
export type HatchNotificationEnvelope = {
  type: HatchNotificationEventType;
  version: 1;
  deliveryId: string;
  /** 1-based; the same deliveryId may arrive again after a failed attempt. */
  attempt: number;
  revision: number;
  /** True for silent edits, recalls and reply events. */
  silent: boolean;
  notification: {
    id: string;
    kind: string;
    kindName: string;
    format: NotificationFormat;
    /**
     * The name it goes by, always a string: the title of a text
     * notification, the summary of a Markdown or card one.
     */
    title: string;
    /**
     * The body of a text notification; the content as plain text for
     * Markdown and cards.
     */
    body: string | null;
    /** One plain line for pushes; always set for Markdown and cards. */
    summary: string | null;
    /** The Markdown source of a Markdown notification; null otherwise. */
    markdown: string | null;
    /**
     * The render tree of a Markdown (`Document` root) or card (`Card` root)
     * notification; null for text.
     */
    content: NotificationContentNode | null;
    url: string | null;
    /** Phone notifications open `url` on tap instead of the notification. */
    autoOpenUrl: boolean;
    priority: NotificationPriority;
    data: { [key: string]: NotificationJson } | null;
    dedupeKey: string | null;
    occurredAt: string;
    revision: number;
    editedAt: string | null;
    recalledAt: string | null;
    /** The form to answer, or null. */
    reply: NotificationReply | null;
    /**
     * A card's status and first progress, stats or quote block in the older
     * status-and-block shape, or null; tones are always filled in.
     *
     * @deprecated Read `format` and `content` instead.
     */
    card: NotificationCard | null;
    /**
     * The answer, only in `hatch.notification.responded` (sent by a response
     * route); null in every other event.
     */
    response: NotificationResponse | null;
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
