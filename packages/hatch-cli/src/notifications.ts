/** `hatch notification ...`: notification center history and configuration. */
import { parseArgs } from 'node:util';
import { toJson, type JsonValue } from '@bufbuild/protobuf';
import { createClient, type Transport } from '@connectrpc/connect';
import { NotificationService } from '../../hatch-platform-api/gen/hatch/platform/v1/notification_pb';
import {
  answerOf,
  type ReplyAnswers,
} from '../../hatch-platform-api/notification-reply';
import {
  answersToMessages,
  replyToMessage,
} from '../../hatch-platform-api/notification-reply-proto';
import {
  describeIssue,
  notificationReplySchema,
} from '../../hatch-platform-api/notification-reply-schema';
import { notificationCardSchema } from '../../hatch-platform-api/notification-card-schema';
import { cardToMessage } from '../../hatch-platform-api/notification-card-proto';
import { configPath, resolveCredential } from './config';
import { platformTransport } from './client';
import { CliError } from './error';
import { readTextInput } from './input';

type Method = keyof typeof NotificationService.method;
type Values = Record<string, string | boolean | string[] | undefined>;

/** One resolved RPC call plus its human-readable rendering. */
export type NotificationCall = {
  method: Method;
  request: Record<string, unknown>;
  /**
   * Read `--*-file` inputs and validate them before any RPC; returns the
   * request fields they supply.
   */
  prepare?: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  text: (response: Record<string, unknown>) => string;
};

type Spec = {
  positionals: readonly string[];
  options?: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;
  build: (positionals: string[], values: Values) => NotificationCall;
};

const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function invalid(message: string): never {
  throw new CliError('invalid_arguments', message);
}

/** `kind[:Display name]`; the display name defaults to the kind. */
export function parseKindSpec(value: string) {
  const separator = value.indexOf(':');
  const kind = separator === -1 ? value : value.slice(0, separator);
  const name = (separator === -1 ? value : value.slice(separator + 1)).trim();
  if (!KIND_RE.test(kind))
    invalid(
      `Invalid kind "${kind}": use 1-64 lowercase letters, digits, ".", "_" or "-".`,
    );
  if (!name || name.length > 80)
    invalid(`Kind "${kind}" needs a display name of 1-80 characters.`);
  return { kind, name };
}

/** Pushover-style priorities; emergency (2) is not supported. */
const PRIORITIES = [
  { value: -2, name: 'lowest', effect: 'history only, not pushed to phones' },
  { value: -1, name: 'low', effect: 'quiet on phones' },
  { value: 0, name: 'normal', effect: '' },
  { value: 1, name: 'high', effect: 'time-sensitive on phones' },
] as const;

/**
 * `--priority` as a name or its number. Names avoid the `--priority=-1`
 * spelling that negative numbers need.
 */
export function parsePriority(value: string): number {
  const text = value.trim().toLowerCase();
  const match = PRIORITIES.find(
    (entry) => entry.name === text || String(entry.value) === text,
  );
  if (!match)
    invalid(
      `Invalid --priority "${value}": use lowest (-2), low (-1), normal (0) or high (1). Emergency priority 2 is not supported.`,
    );
  return match.value;
}

/** Proto3 JSON omits a zero priority. */
function priorityOf(row: Row | undefined): number {
  return Number(row?.priority ?? 0);
}

function priorityText(priority: number): string {
  const entry = PRIORITIES.find((candidate) => candidate.value === priority);
  if (!entry) return String(priority);
  return `${entry.name} (${priority})${entry.effect ? ` · ${entry.effect}` : ''}`;
}

/** Delivery status, a non-normal priority and whether it was edited/recalled. */
function revisionLabel(row: Row | undefined): string {
  const parts = [field(row, 'status')];
  const priority = priorityOf(row);
  if (priority !== 0)
    parts.push(
      PRIORITIES.find((entry) => entry.value === priority)?.name ??
        `priority ${priority}`,
    );
  if (field(row, 'recalledAt')) parts.push('recalled');
  else if (field(row, 'editedAt')) parts.push('edited');
  return parts.join(', ');
}

const KIND_DESCRIPTION_MAX = 500;

/**
 * Resolve `--kind` specs plus `--kind-description <kind>=<text>` into the full
 * kind list. Every described kind must be declared in the same command,
 * because the list always replaces the channel's kinds as a whole.
 */
export function parseKindList(
  specs: readonly string[],
  descriptions: readonly string[],
) {
  const kinds = specs.map(parseKindSpec);
  const declared = new Set(kinds.map((entry) => entry.kind));
  const described = new Map<string, string>();
  for (const value of descriptions) {
    const separator = value.indexOf('=');
    if (separator === -1)
      invalid(`--kind-description "${value}" must be <kind>=<text>.`);
    const kind = value.slice(0, separator);
    const text = value.slice(separator + 1).trim();
    if (!declared.has(kind))
      invalid(
        `--kind-description names "${kind}", which is not in the --kind list.`,
      );
    if (described.has(kind))
      invalid(`Kind "${kind}" has more than one --kind-description.`);
    if (!text || text.length > KIND_DESCRIPTION_MAX)
      invalid(
        `Kind "${kind}" needs a description of 1-${KIND_DESCRIPTION_MAX} characters.`,
      );
    described.set(kind, text);
  }
  return kinds.map((entry) => {
    const description = described.get(entry.kind);
    return description === undefined ? entry : { ...entry, description };
  });
}

function exclusive(values: Values, ...flags: string[]) {
  const present = flags.filter((flag) => values[flag] !== undefined);
  if (present.length > 1)
    invalid(`Use only one of ${flags.map((flag) => `--${flag}`).join(', ')}.`);
}

function enabledFlag(values: Values): boolean | undefined {
  exclusive(values, 'enable', 'disable');
  return values.enable ? true : values.disable ? false : undefined;
}

function lifecycleFlag(values: Values): boolean | undefined {
  exclusive(values, 'lifecycle-events', 'no-lifecycle-events');
  return values['lifecycle-events']
    ? true
    : values['no-lifecycle-events']
      ? false
      : undefined;
}

/** A flag holding a JSON object, passed on as its original text. */
function jsonObjectFlag(values: Values, flag: string): string | undefined {
  const text = str(values, flag);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid(`--${flag} must be a JSON object.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    invalid(`--${flag} must be a JSON object.`);
  return text;
}

const JSON_INPUT_MAX_BYTES = 64 * 1024;

/**
 * JSON from `--<flag> <json>` or `--<flag>-file <path|->`. Returns a loader,
 * or undefined when neither flag is given.
 */
function jsonInput(
  values: Values,
  flag: string,
): ((signal: AbortSignal) => Promise<unknown>) | undefined {
  exclusive(values, flag, `${flag}-file`);
  const parse = (text: string, source: string) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      invalid(`${source} must be valid JSON.`);
    }
  };
  const inline = str(values, flag);
  if (inline !== undefined) {
    const value = parse(inline, `--${flag}`);
    return async () => value;
  }
  const path = str(values, `${flag}-file`);
  if (path === undefined) return undefined;
  if (!path) invalid(`--${flag}-file needs a path or -.`);
  return async (signal) =>
    parse(
      await readTextInput(path, signal, JSON_INPUT_MAX_BYTES),
      `--${flag}-file`,
    );
}

/** Validate a reply form exactly as the platform does. */
export function parseReplyForm(value: unknown, flag = 'reply') {
  const parsed = notificationReplySchema.safeParse(value);
  if (!parsed.success) invalid(`--${flag}: ${describeIssue(parsed.error)}`);
  return parsed.data;
}

/** Validate a card exactly as the platform does; an empty card is rejected. */
export function parseCard(value: unknown, flag = 'card') {
  const parsed = notificationCardSchema.safeParse(value);
  if (!parsed.success) invalid(`--${flag}: ${describeIssue(parsed.error)}`);
  if (!parsed.data)
    invalid(`--${flag}: give a status or a block, or use --clear-card.`);
  return parsed.data;
}

/** Load and check `--card`/`--card-file` before any request is made. */
function cardPreparation(
  values: Values,
):
  | ((
      signal: AbortSignal,
    ) => Promise<{ card: ReturnType<typeof cardToMessage> }>)
  | undefined {
  const card = jsonInput(values, 'card');
  if (!card) return undefined;
  const flag = values.card === undefined ? 'card-file' : 'card';
  return async (signal) => ({
    card: cardToMessage(parseCard(await card(signal), flag)),
  });
}

/**
 * Answers from `--answers <json>`/`--answers-file`, or from repeated
 * `--answer <field>=<value>`; repeating a field makes a list (a multiple
 * field). The platform checks them against the notification's form.
 */
export function parseAnswerFlags(values: readonly string[]): ReplyAnswers {
  const answers: ReplyAnswers = {};
  for (const entry of values) {
    const separator = entry.indexOf('=');
    if (separator <= 0)
      invalid(`--answer "${entry}" must be <field-id>=<value>.`);
    const fieldId = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    const current = answerOf(answers, fieldId);
    answers[fieldId] =
      current === undefined
        ? value
        : Array.isArray(current)
          ? [...current, value]
          : [current, value];
  }
  return answers;
}

export function checkAnswersObject(value: unknown, flag: string): ReplyAnswers {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`--${flag} must be a JSON object keyed by field id.`);
  for (const [fieldId, answer] of Object.entries(value)) {
    const ok =
      typeof answer === 'string' ||
      (Array.isArray(answer) &&
        answer.every((entry) => typeof entry === 'string'));
    if (!ok)
      invalid(
        `--${flag}: answer "${fieldId}" must be a string or a list of option ids.`,
      );
  }
  return value as ReplyAnswers;
}

type ReplyRow = {
  fields?: {
    id?: string;
    type?: string;
    label?: string;
    required?: boolean;
    options?: { id?: string; label?: string }[];
  }[];
};

/** Answers in proto JSON (`{value}` / `{optionIds: {ids}}`) as labels. */
function answerLines(reply: ReplyRow | undefined, answers: unknown): string[] {
  const map =
    answers && typeof answers === 'object'
      ? (answers as Record<
          string,
          { value?: string; optionIds?: { ids?: string[] } }
        >)
      : {};
  return (reply?.fields ?? []).flatMap((replyField) => {
    const answer = answerOf(map, replyField.id ?? '');
    if (!answer) return [];
    const labels = new Map(
      (replyField.options ?? []).map((option) => [option.id, option.label]),
    );
    const ids =
      answer.optionIds?.ids ??
      (answer.value !== undefined ? [answer.value] : []);
    const value =
      replyField.type === 'text'
        ? (answer.value ?? '')
        : ids
            .map(
              (optionId) => `${labels.get(optionId) ?? optionId} [${optionId}]`,
            )
            .join(', ');
    return [`  ${replyField.label} [${replyField.id}]: ${value}`];
  });
}

function replyLines(reply: ReplyRow | undefined): string[] {
  return (reply?.fields ?? []).map((replyField) => {
    const options = (replyField.options ?? [])
      .map((option) => `${option.id}=${option.label}`)
      .join(', ');
    return `  ${replyField.id} (${replyField.type}${
      replyField.required === false ? ', optional' : ''
    }): ${replyField.label}${options ? ` — ${options}` : ''}`;
  });
}

/** Reply state shown next to the delivery status. */
function replyLabel(row: Row | undefined): string {
  if (!row?.reply) return '';
  if (field(row, 'respondedAt')) return 'answered';
  return field(row, 'recalledAt') ? '' : 'awaiting answer';
}

function responseRouteLine(row: Row) {
  const source =
    field(row, 'sourceType') === 'any'
      ? 'any source'
      : `${field(row, 'sourceType')}:${field(row, 'sourceId') || '*'}`;
  return [
    field(row, 'id'),
    row.enabled === false ? 'disabled' : 'enabled',
    `${source} / ${field(row, 'kind') || '*'}`,
    field(row, 'targetType') === 'agent'
      ? `→ agent:${field(row, 'agentSessionId') || 'chat per notification'}`
      : `→ destination:${field(row, 'destinationId')}`,
    field(row, 'name'),
  ];
}

/** A value, its `--clear-` flag (sent as ""), or undefined to keep it. */
function clearable(values: Values, flag: string): string | undefined {
  exclusive(values, flag, `clear-${flag}`);
  return values[`clear-${flag}`] ? '' : str(values, flag);
}

function str(values: Values, flag: string): string | undefined {
  const value = values[flag];
  return typeof value === 'string' ? value : undefined;
}

function list(values: Values, flag: string): string[] | undefined {
  const value = values[flag];
  return Array.isArray(value) ? value : undefined;
}

/**
 * The one id flag of `flags` that is present. A present but blank id is an
 * error, never an omitted flag, so `--destination "$UNSET"` fails loudly.
 */
function oneOf<const Flag extends string>(
  values: Values,
  flags: readonly Flag[],
): { flag: Flag; id: string } | undefined {
  exclusive(values, ...flags);
  for (const flag of flags) {
    const id = str(values, flag);
    if (id === undefined) continue;
    if (!id.trim()) invalid(`--${flag} needs a non-empty id.`);
    return { flag, id };
  }
  return undefined;
}

/** A route's `--group` or `--destination`. */
function target(values: Values) {
  const to = oneOf(values, ['group', 'destination']);
  return to && { targetType: to.flag, targetId: to.id };
}

function sourceType(value: string | undefined, allowed: readonly string[]) {
  if (value !== undefined && !allowed.includes(value))
    invalid(`--source-type must be one of ${allowed.join(', ')}.`);
  return value;
}

type Row = Record<string, unknown>;
const rows = (value: unknown) => (Array.isArray(value) ? (value as Row[]) : []);
const field = (row: Row | undefined, key: string) =>
  row?.[key] === undefined || row[key] === null ? '' : String(row[key]);
const table = (lines: string[][]) => {
  if (lines.length === 0) return '(none)';
  const widths = lines[0].map((_, index) =>
    Math.max(...lines.map((line) => line[index]?.length ?? 0)),
  );
  return lines
    .map((line) =>
      line
        .map((cell, index) =>
          index === line.length - 1 ? cell : cell.padEnd(widths[index]),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
};

function destinationLines(response: Record<string, unknown>, key: string) {
  return table(
    rows(response[key]).map((row) => {
      const detail =
        field(row.webhook as Row, 'url') ||
        field(row.app as Row, 'slug') ||
        [
          field(row.device as Row, 'userName'),
          field(row.device as Row, 'environment'),
        ]
          .filter(Boolean)
          .join(' · ');
      // Devices always take edits and recalls; say so only where it varies.
      const changes = [
        row.type !== 'device' && row.lifecycleEvents === true
          ? 'edits+recalls'
          : '',
        row.type === 'app' && row.acceptsResponses === true ? 'responses' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return [
        field(row, 'id'),
        field(row, 'type'),
        row.enabled === false ? 'disabled' : 'enabled',
        field(row, 'name'),
        [detail, changes].filter(Boolean).join(' · '),
      ];
    }),
  );
}

function routeLine(row: Row) {
  const source =
    field(row, 'sourceType') === 'any'
      ? 'any source'
      : `${field(row, 'sourceType')}:${field(row, 'sourceId') || '*'}`;
  return [
    field(row, 'id'),
    row.enabled === false ? 'disabled' : 'enabled',
    `${source} / ${field(row, 'kind') || '*'}`,
    `→ ${field(row, 'targetType')}:${field(row, 'targetId')}`,
    field(row, 'name'),
  ];
}

function channelSecret(response: Record<string, unknown>, label: string) {
  const channel = response.channel as Row | undefined;
  return [
    ...(channel
      ? [`Channel ${field(channel, 'id')} (${field(channel, 'name')})`]
      : []),
    ...(channel ? [`Push URL: ${field(channel, 'pushUrl')}`] : []),
    `${label}: ${field(response, 'token')}`,
    'Store it now; it is not shown again. Send it as x-hatch-secret.',
    ...(channel
      ? []
      : ['The push URL is unchanged; see hatch notification channel list.']),
  ].join('\n');
}

const done = (message: string) => () => message;
const id = { positionals: ['id'] } as const;

/** `--limit` as a page size (1–100), or 0 for the server default. */
function pageLimit(values: Values): number {
  const limit = str(values, 'limit');
  if (limit === undefined) return 0;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100)
    invalid('--limit must be an integer between 1 and 100.');
  return parsed;
}

const page = (lines: string, response: Row) => {
  const next = field(response, 'nextCursor');
  return next ? `${lines}\nMore: --cursor ${next}` : lines;
};

/** The caller's read position: what is unread and where reading stopped. */
function readStateText(response: Row): string {
  const state = response.state as Row | undefined;
  const count = Number(state?.unreadCount ?? 0);
  const through = field(state, 'readThroughId');
  const first = field(state, 'firstUnreadId');
  return [
    count === 0
      ? 'No unread notifications.'
      : `${count} unread; the oldest is ${first}.`,
    through
      ? `Read through ${through} (${field(state, 'readThroughAt')}).`
      : `Read through ${field(state, 'readThroughAt')}.`,
  ].join('\n');
}

const specs: Record<string, Spec> = {
  list: {
    positionals: [],
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      status: { type: 'string' },
      'reply-state': { type: 'string' },
      order: { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
    },
    build: (_positionals, values) => {
      const order = str(values, 'order');
      if (order !== undefined && !['created', 'activity'].includes(order))
        invalid('--order must be created or activity.');
      const byActivity = order === 'activity';
      const replyState = str(values, 'reply-state');
      if (
        replyState !== undefined &&
        !['awaiting', 'answered'].includes(replyState)
      )
        invalid('--reply-state must be awaiting or answered.');
      const status = str(values, 'status');
      if (
        status !== undefined &&
        !['unrouted', 'pending', 'delivered', 'partial', 'failed'].includes(
          status,
        )
      )
        invalid(
          '--status must be unrouted, pending, delivered, partial or failed.',
        );
      return {
        method: 'listNotifications',
        request: {
          sourceType: sourceType(str(values, 'source-type'), [
            'app',
            'channel',
            'platform',
            'user',
          ]),
          sourceId: str(values, 'source'),
          kind: str(values, 'kind'),
          status,
          replyState,
          order,
          cursor: str(values, 'cursor'),
          limit: pageLimit(values),
        },
        text: (response) =>
          page(
            table(
              rows(response.notifications).map((row) => [
                field(row, 'id'),
                field(row, byActivity ? 'activityAt' : 'createdAt'),
                [revisionLabel(row), replyLabel(row)]
                  .filter(Boolean)
                  .join(', '),
                `${field(row, 'sourceName')} / ${field(row, 'kind')}`,
                field(row, 'title'),
              ]),
            ),
            response,
          ),
      };
    },
  },
  get: {
    ...id,
    build: ([notificationId]) => ({
      method: 'getNotification',
      request: { id: notificationId },
      text: (response) => {
        const detail = response.notification as Row | undefined;
        const summary = detail?.summary as Row | undefined;
        const revision = Number(summary?.revision ?? 1);
        const answerDeliveries = rows(detail?.responseDeliveries).map((row) => [
          field(row, 'id'),
          field(row, 'status'),
          `${field(row, 'destinationType')}:${field(row, 'destinationName')}`,
          `attempts ${field(row, 'attempts')}`,
          [
            field(row, 'result') && `result: ${field(row, 'result')}`,
            field(row, 'lastError') && `error: ${field(row, 'lastError')}`,
          ]
            .filter(Boolean)
            .join(' · '),
        ]);
        const reply = summary?.reply as ReplyRow | undefined;
        const answered = detail?.response as Row | undefined;
        const replySection = reply
          ? [
              '',
              `Reply form (round ${field(summary, 'replyRound') || 1}):`,
              ...replyLines(reply),
              ...(answered
                ? [
                    `Answered by ${field(answered, 'respondedByName')} via ${field(answered, 'via')} at ${field(answered, 'respondedAt')}:`,
                    ...answerLines(reply, answered.answers),
                    '',
                    'Answer deliveries:',
                    table(answerDeliveries),
                  ]
                : field(summary, 'recalledAt')
                  ? ['Not answered; recalled.']
                  : [
                      `Not answered yet. Answer with: hatch notification respond ${field(summary, 'id')} --round ${field(summary, 'replyRound') || 1} --answer <field-id>=<value>`,
                    ]),
            ]
          : [];
        const deliveries = rows(detail?.deliveries).map((row) => {
          const received = Number(row.deliveredRevision ?? 0);
          // Destinations that take edits and recalls are re-queued for each
          // change, so one that finished behind the latest revision takes none.
          const changes =
            revision <= 1 || !received
              ? ''
              : received >= revision
                ? `revision ${received} (latest)`
                : row.status === 'succeeded'
                  ? `revision ${received} of ${revision}; takes no edits or recalls`
                  : `revision ${received} of ${revision}`;
          const extra = [
            changes,
            field(row, 'result') && `result: ${field(row, 'result')}`,
            field(row, 'lastError') && `error: ${field(row, 'lastError')}`,
          ]
            .filter(Boolean)
            .join(' · ');
          return [
            field(row, 'id'),
            field(row, 'status'),
            `${field(row, 'destinationType')}:${field(row, 'destinationName')}`,
            `attempts ${field(row, 'attempts')}`,
            extra,
          ];
        });
        return [
          `${field(summary, 'title')} (${revisionLabel(summary)})`,
          `Source: ${field(summary, 'sourceName')} (${field(summary, 'sourceType')}) · Kind: ${field(summary, 'kindName')} [${field(summary, 'kind')}]`,
          `Priority: ${priorityText(priorityOf(summary))}`,
          `Occurred: ${field(summary, 'occurredAt')}`,
          ...(field(summary, 'editedAt')
            ? [`Edited: ${field(summary, 'editedAt')}`]
            : []),
          ...(Number(summary?.earlierVersions ?? 0) > 0
            ? [
                `Earlier versions: ${field(summary, 'earlierVersions')} (hatch notification revisions ${field(summary, 'id')})`,
              ]
            : []),
          ...(field(summary, 'recalledAt')
            ? [`Recalled: ${field(summary, 'recalledAt')}`]
            : []),
          ...(field(summary, 'body') ? ['', field(summary, 'body')] : []),
          ...(field(summary, 'url')
            ? [
                `URL: ${field(summary, 'url')}${
                  summary?.autoOpenUrl === true ? ' (opens on phone tap)' : ''
                }`,
              ]
            : []),
          ...replySection,
          '',
          'Deliveries:',
          table(deliveries),
        ].join('\n');
      },
    }),
  },
  test: {
    positionals: ['destination-id'],
    build: ([destinationId]) => ({
      method: 'sendTestNotification',
      request: { destinationId },
      text: (response) =>
        `Sent test notification ${field(response, 'notificationId')}.`,
    }),
  },
  send: {
    positionals: [],
    options: {
      channel: { type: 'string' },
      group: { type: 'string' },
      destination: { type: 'string' },
      kind: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      url: { type: 'string' },
      'no-auto-open-url': { type: 'boolean' },
      priority: { type: 'string' },
      data: { type: 'string' },
      'dedupe-key': { type: 'string' },
      'occurred-at': { type: 'string' },
      reply: { type: 'string' },
      'reply-file': { type: 'string' },
      card: { type: 'string' },
      'card-file': { type: 'string' },
    },
    build: (_positionals, values) => {
      const to = oneOf(values, ['channel', 'group', 'destination']);
      const card = cardPreparation(values);
      if (!to) invalid('Supply one of --channel, --group or --destination.');
      const reply = jsonInput(values, 'reply');
      const kind = str(values, 'kind');
      const title = str(values, 'title');
      if (!title?.trim()) invalid('Supply --title.');
      // A Channel only accepts its declared kinds; elsewhere kind is a label.
      if (to.flag === 'channel' && !kind)
        invalid('Supply --kind when sending to a channel.');
      if (kind !== undefined && !KIND_RE.test(kind))
        invalid(
          `Invalid kind "${kind}": use 1-64 lowercase letters, digits, ".", "_" or "-".`,
        );
      const data = jsonObjectFlag(values, 'data');
      const priority = str(values, 'priority');
      return {
        method: 'sendNotification',
        request: {
          [`${to.flag}Id`]: to.id,
          kind,
          title,
          body: str(values, 'body'),
          url: str(values, 'url'),
          // Unset lets the platform open --url on phone tap by default.
          autoOpenUrl: values['no-auto-open-url'] ? false : undefined,
          priority:
            priority === undefined ? undefined : parsePriority(priority),
          dataJson: data,
          dedupeKey: str(values, 'dedupe-key'),
          occurredAt: str(values, 'occurred-at'),
        },
        ...(reply || card
          ? {
              prepare: async (signal: AbortSignal) => ({
                ...(reply
                  ? {
                      reply: replyToMessage(
                        parseReplyForm(
                          await reply(signal),
                          values.reply === undefined ? 'reply-file' : 'reply',
                        ),
                      ),
                    }
                  : {}),
                ...(card ? await card(signal) : {}),
              }),
            }
          : {}),
        text: (response) => {
          const notificationId = field(response, 'notificationId');
          if (response.deduplicated === true)
            return `Notification ${notificationId} already exists for this dedupe key; nothing new was sent.`;
          const count = Number(response.deliveryCount ?? 0);
          if (count === 0 && to.flag === 'group')
            return [
              `Sent notification ${notificationId}, but nothing was delivered: the group has no enabled destinations.`,
              'Check hatch notification group list and hatch notification destination list.',
            ].join('\n');
          if (count === 0)
            return [
              `Sent notification ${notificationId}, but nothing was delivered: no route matched it, or every matched destination is disabled.`,
              'Check hatch notification route list and hatch notification destination list.',
            ].join('\n');
          return `Sent notification ${notificationId} to ${count} destination${count === 1 ? '' : 's'}.`;
        },
      };
    },
  },
  update: {
    positionals: ['notification-id'],
    options: {
      silent: { type: 'boolean' },
      title: { type: 'string' },
      body: { type: 'string' },
      'clear-body': { type: 'boolean' },
      url: { type: 'string' },
      'clear-url': { type: 'boolean' },
      'auto-open-url': { type: 'boolean' },
      'no-auto-open-url': { type: 'boolean' },
      data: { type: 'string' },
      'clear-data': { type: 'boolean' },
      reply: { type: 'string' },
      'reply-file': { type: 'string' },
      'clear-reply': { type: 'boolean' },
      card: { type: 'string' },
      'card-file': { type: 'string' },
      'clear-card': { type: 'boolean' },
    },
    build: ([id], values) => {
      exclusive(values, 'auto-open-url', 'no-auto-open-url');
      const reply = jsonInput(values, 'reply');
      const clearReply = values['clear-reply'] === true;
      if (reply && clearReply)
        invalid('Use either --reply/--reply-file or --clear-reply, not both.');
      const card = cardPreparation(values);
      const clearCard = values['clear-card'] === true;
      if (card && clearCard)
        invalid('Use either --card/--card-file or --clear-card, not both.');
      const title = str(values, 'title');
      if (title !== undefined && !title.trim())
        invalid('--title cannot be empty.');
      exclusive(values, 'data', 'clear-data');
      const request = {
        id,
        silent: values.silent === true,
        title,
        body: clearable(values, 'body'),
        url: clearable(values, 'url'),
        autoOpenUrl: values['auto-open-url']
          ? true
          : values['no-auto-open-url']
            ? false
            : undefined,
        dataJson: values['clear-data'] ? '' : jsonObjectFlag(values, 'data'),
        clearReply: clearReply || undefined,
        clearCard: clearCard || undefined,
      };
      const { id: _, silent, ...changes } = request;
      if (
        silent &&
        !reply &&
        !card &&
        Object.values(changes).every((value) => value === undefined)
      )
        invalid(
          'Supply at least one change: --title, --[clear-]body, --[clear-]url, --[no-]auto-open-url, --[clear-]data, --reply/--clear-reply or --card/--clear-card.',
        );
      return {
        method: 'updateNotification',
        request,
        ...(reply || card
          ? {
              prepare: async (signal: AbortSignal) => ({
                ...(reply
                  ? {
                      reply: replyToMessage(
                        parseReplyForm(
                          await reply(signal),
                          values.reply === undefined ? 'reply-file' : 'reply',
                        ),
                      ),
                    }
                  : {}),
                ...(card ? await card(signal) : {}),
              }),
            }
          : {}),
        text: (response) =>
          response.changed === true
            ? `Updated notification ${id} (revision ${field(response, 'revision')}). ${silent ? 'Content changes without another phone alert.' : 'Phones alert again with the latest content.'} Destinations that take edits receive the update.`
            : `Notification ${id} already has this content; nothing was sent.`,
      };
    },
  },
  recall: {
    positionals: ['notification-id'],
    build: ([id]) => ({
      method: 'recallNotification',
      request: { id },
      text: (response) =>
        response.changed === true
          ? `Recalled notification ${id} (revision ${field(response, 'revision')}). Phones remove it, destinations that have not received it never will, and those that take recalls are told.`
          : `Notification ${id} was already recalled; nothing was sent.`,
    }),
  },
  respond: {
    positionals: ['notification-id'],
    options: {
      answer: { type: 'string', multiple: true },
      answers: { type: 'string' },
      'answers-file': { type: 'string' },
      round: { type: 'string' },
    },
    build: ([notificationId], values) => {
      // Required: an answer without the round read could land on a newer
      // question that reuses the same field and option ids.
      const roundFlag = str(values, 'round');
      const round = Number(roundFlag);
      if (
        roundFlag !== undefined &&
        (!Number.isInteger(round) || round < 1 || round > 2 ** 31 - 1)
      )
        invalid(
          '--round must be a positive integer (the reply round from get).',
        );
      const shorthand = list(values, 'answer');
      const loader = jsonInput(values, 'answers');
      if (shorthand && loader)
        invalid('Use either --answer or --answers/--answers-file, not both.');
      if (!shorthand && !loader)
        invalid(
          'Supply --answer <field-id>=<value>... or --answers <json> / --answers-file <path|->.',
        );
      if (roundFlag === undefined)
        invalid(
          'Supply --round <n>, the reply round get printed for the form you answer.',
        );
      const flag = values.answers !== undefined ? 'answers' : 'answers-file';
      const pairs = shorthand ? parseAnswerFlags(shorthand) : undefined;
      return {
        method: 'respondToNotification',
        request: { id: notificationId, via: 'cli', round },
        prepare: async (signal) => ({
          answers: answersToMessages(
            pairs ?? checkAnswersObject(await loader!(signal), flag),
          ),
        }),
        text: (response) => {
          const answered = response.response as Row | undefined;
          return `Answered notification ${notificationId} as ${field(answered, 'respondedByName')}. Response routes deliver the answer; see hatch notification get ${notificationId}.`;
        },
      };
    },
  },
  revisions: {
    ...id,
    options: { limit: { type: 'string' }, cursor: { type: 'string' } },
    build: ([notificationId], values) => ({
      method: 'listNotificationRevisions',
      request: {
        id: notificationId,
        cursor: str(values, 'cursor'),
        limit: pageLimit(values),
      },
      text: (response) => {
        const revisions = rows(response.revisions);
        const answers = rows(response.responses);
        const lines = revisions.map(
          (row) =>
            `revision ${field(row, 'revision')} (${field(row, 'activityAt')} → ${field(row, 'replacedAt')}, round ${field(row, 'replyRound')}): ${field(row, 'title')}`,
        );
        const answered = answers.map(
          (row) =>
            `round ${field(row, 'round')}: answered by ${field(row, 'respondedByName')} via ${field(row, 'via')} at ${field(row, 'respondedAt')}`,
        );
        return page(
          [
            revisions.length
              ? 'Earlier versions, newest first:'
              : 'No earlier versions: it was never edited.',
            ...lines,
            ...(answered.length ? ['', 'Answers:', ...answered] : []),
          ].join('\n'),
          response,
        );
      },
    }),
  },
  unread: {
    positionals: [],
    build: () => ({
      method: 'getNotificationReadState',
      request: {},
      text: readStateText,
    }),
  },
  'mark-read': {
    positionals: [],
    options: {
      through: { type: 'string' },
      at: { type: 'string' },
      latest: { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const through = str(values, 'through');
      const at = str(values, 'at');
      const latest = values.latest === true;
      if (at !== undefined && through === undefined)
        invalid('--at needs --through <notification-id>.');
      if (at !== undefined && Number.isNaN(new Date(at).getTime()))
        invalid(
          '--at must be an ISO 8601 time, the activity time list --order activity printed.',
        );
      if (through !== undefined && latest)
        invalid(
          'Use either --through <notification-id> or --latest, not both.',
        );
      if (through === undefined && !latest)
        invalid('Supply --through <notification-id> or --latest.');
      return {
        method: 'markNotificationsRead',
        request: {
          through:
            through !== undefined
              ? { case: 'notificationId', value: through }
              : { case: 'latest', value: true },
          activityAt: at === undefined ? '' : new Date(at).toISOString(),
        },
        text: readStateText,
      };
    },
  },
  delete: {
    positionals: ['notification-id'],
    options: { yes: { type: 'boolean' } },
    build: ([id], values) => {
      // Deleting is permanent and workspace-wide; never infer consent.
      if (values.yes !== true)
        invalid(
          'Deleting a notification is permanent. Pass --yes to delete it and its delivery history.',
        );
      return {
        method: 'deleteNotification',
        request: { id },
        text: done(
          `Deleted notification ${id} and its delivery history. Copies destinations already received were not touched.`,
        ),
      };
    },
  },
  retry: {
    positionals: ['delivery-id'],
    build: ([deliveryId]) => ({
      method: 'retryDelivery',
      request: { deliveryId },
      text: done('Delivery queued for retry.'),
    }),
  },
  sources: {
    positionals: [],
    build: () => ({
      method: 'listNotificationSources',
      request: {},
      text: (response) => {
        const kindText = (row: Row) =>
          rows(row.kinds)
            .map((kind) => field(kind, 'kind'))
            .join(', ');
        return table([
          ...rows(response.apps).map((row) => [
            'app',
            field(row, 'id'),
            field(row, 'name'),
            kindText(row),
          ]),
          ...rows(response.channels).map((row) => [
            'channel',
            field(row, 'id'),
            field(row, 'name'),
            kindText(row),
          ]),
          // Direct sends have no source id; their kinds come from history.
          ...(rows(response.userKinds).length > 0
            ? [
                [
                  'user',
                  '-',
                  'Sent by people',
                  kindText({ kinds: response.userKinds }),
                ],
              ]
            : []),
        ]);
      },
    }),
  },
  'apns-status': {
    positionals: [],
    build: () => ({
      method: 'getApnsStatus',
      request: {},
      text: (response) => {
        if (field(response, 'error'))
          return `iOS push is misconfigured: ${field(response, 'error')}`;
        const environments = [
          response.production === true ? 'production' : '',
          response.sandbox === true ? 'sandbox' : '',
        ].filter(Boolean);
        if (environments.length === 0)
          return 'iOS push: no APNs key is configured yet, so device deliveries will fail.';
        return [
          `iOS push: ${
            field(response, 'source') === 'builtin'
              ? 'built-in shared key'
              : 'this instance’s own key'
          } (${environments.join(', ')}).`,
          ...(field(response, 'topic')
            ? [`Topic: ${field(response, 'topic')}`]
            : []),
        ].join('\n');
      },
    }),
  },
  'destination list': {
    positionals: [],
    build: () => ({
      method: 'listDestinations',
      request: {},
      text: (response) => destinationLines(response, 'destinations'),
    }),
  },
  'destination enable': {
    ...id,
    build: ([destinationId]) => ({
      method: 'updateDestination',
      request: { id: destinationId, enabled: true },
      text: done('Destination enabled.'),
    }),
  },
  'destination disable': {
    ...id,
    build: ([destinationId]) => ({
      method: 'updateDestination',
      request: { id: destinationId, enabled: false },
      text: done('Destination disabled.'),
    }),
  },
  'destination rename': {
    positionals: ['id', 'name'],
    build: ([destinationId, name]) => ({
      method: 'updateDestination',
      request: { id: destinationId, name },
      text: done('Destination renamed.'),
    }),
  },
  'destination delete': {
    ...id,
    build: ([destinationId]) => ({
      method: 'deleteDestination',
      request: { id: destinationId },
      text: done('Destination deleted.'),
    }),
  },
  'webhook create': {
    positionals: [],
    options: {
      name: { type: 'string' },
      url: { type: 'string' },
      'lifecycle-events': { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const name = str(values, 'name');
      const url = str(values, 'url');
      if (!name || !url) invalid('Supply --name and --url.');
      return {
        method: 'createWebhook',
        request: {
          name,
          url,
          lifecycleEvents: values['lifecycle-events'] === true,
        },
        text: (response) =>
          [
            `Webhook ${field(response.destination as Row, 'id')} created.`,
            `Signing secret: ${field(response, 'secret')}`,
            'Store it now; it is not shown again. Verify x-hatch-signature with it.',
          ].join('\n'),
      };
    },
  },
  'webhook update': {
    ...id,
    options: {
      name: { type: 'string' },
      url: { type: 'string' },
      'lifecycle-events': { type: 'boolean' },
      'no-lifecycle-events': { type: 'boolean' },
    },
    build: ([destinationId], values) => {
      const request = {
        id: destinationId,
        name: str(values, 'name'),
        url: str(values, 'url'),
        lifecycleEvents: lifecycleFlag(values),
      };
      if (
        request.name === undefined &&
        request.url === undefined &&
        request.lifecycleEvents === undefined
      )
        invalid('Supply --name, --url or --[no-]lifecycle-events.');
      return {
        method: 'updateDestination',
        request,
        text: done('Webhook updated.'),
      };
    },
  },
  'webhook rotate-secret': {
    ...id,
    build: ([destinationId]) => ({
      method: 'rotateWebhookSecret',
      request: { id: destinationId },
      text: (response) =>
        `New signing secret: ${field(response, 'secret')}\nStore it now; it is not shown again.`,
    }),
  },
  'webhook delete': {
    ...id,
    build: ([destinationId]) => ({
      method: 'deleteDestination',
      request: { id: destinationId },
      text: done('Webhook deleted.'),
    }),
  },
  'group list': {
    positionals: [],
    build: () => ({
      method: 'listGroups',
      request: {},
      text: (response) =>
        table(
          rows(response.groups).map((row) => [
            field(row, 'id'),
            field(row, 'name'),
            `${Array.isArray(row.destinationIds) ? row.destinationIds.length : 0} destination(s)`,
            row.autoAddDevices === true ? 'auto-adds new devices' : '',
          ]),
        ),
    }),
  },
  'group create': {
    positionals: [],
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      destination: { type: 'string', multiple: true },
      'auto-add-devices': { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const name = str(values, 'name');
      if (!name) invalid('Supply --name.');
      return {
        method: 'createGroup',
        request: {
          name,
          description: str(values, 'description'),
          autoAddDevices: values['auto-add-devices'] ? true : undefined,
          destinationIds: { ids: list(values, 'destination') ?? [] },
        },
        text: (response) =>
          `Group ${field(response.group as Row, 'id')} created.`,
      };
    },
  },
  'group update': {
    ...id,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      destination: { type: 'string', multiple: true },
      'clear-destinations': { type: 'boolean' },
      'auto-add-devices': { type: 'boolean' },
      'no-auto-add-devices': { type: 'boolean' },
    },
    build: ([groupId], values) => {
      exclusive(values, 'destination', 'clear-destinations');
      exclusive(values, 'auto-add-devices', 'no-auto-add-devices');
      const destinations = values['clear-destinations']
        ? []
        : list(values, 'destination');
      const request = {
        id: groupId,
        name: str(values, 'name'),
        description: str(values, 'description'),
        autoAddDevices: values['auto-add-devices']
          ? true
          : values['no-auto-add-devices']
            ? false
            : undefined,
        destinationIds:
          destinations === undefined ? undefined : { ids: destinations },
      };
      if (
        request.name === undefined &&
        request.description === undefined &&
        request.autoAddDevices === undefined &&
        request.destinationIds === undefined
      )
        invalid(
          'Supply --name, --description, --destination, --clear-destinations or --[no-]auto-add-devices.',
        );
      return {
        method: 'updateGroup',
        request,
        text: done('Group updated.'),
      };
    },
  },
  'group delete': {
    ...id,
    build: ([groupId]) => ({
      method: 'deleteGroup',
      request: { id: groupId },
      text: done('Group deleted.'),
    }),
  },
  'route list': {
    positionals: [],
    build: () => ({
      method: 'listRoutes',
      request: {},
      text: (response) => table(rows(response.routes).map(routeLine)),
    }),
  },
  'route create': {
    positionals: [],
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      group: { type: 'string' },
      destination: { type: 'string' },
      name: { type: 'string' },
      disabled: { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const type = sourceType(str(values, 'source-type'), [
        'app',
        'channel',
        'any',
      ]);
      if (!type) invalid('Supply --source-type app, channel or any.');
      if (type === 'any' && values.source !== undefined)
        invalid('--source cannot be combined with --source-type any.');
      const to = target(values);
      if (!to) invalid('Supply exactly one of --group or --destination.');
      return {
        method: 'createRoute',
        request: {
          name: str(values, 'name'),
          sourceType: type,
          sourceId: str(values, 'source'),
          kind: str(values, 'kind'),
          ...to,
          enabled: values.disabled ? false : undefined,
        },
        text: (response) =>
          table([routeLine((response.route as Row | undefined) ?? {})]),
      };
    },
  },
  'route update': {
    ...id,
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      'any-source': { type: 'boolean' },
      kind: { type: 'string' },
      'any-kind': { type: 'boolean' },
      group: { type: 'string' },
      destination: { type: 'string' },
      name: { type: 'string' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    },
    build: ([routeId], values) => {
      exclusive(values, 'source', 'any-source');
      exclusive(values, 'kind', 'any-kind');
      const request = {
        id: routeId,
        name: str(values, 'name'),
        sourceType: sourceType(str(values, 'source-type'), [
          'app',
          'channel',
          'any',
        ]),
        // Empty strings clear the filter server-side ("any").
        sourceId: values['any-source'] ? '' : str(values, 'source'),
        kind: values['any-kind'] ? '' : str(values, 'kind'),
        ...target(values),
        enabled: enabledFlag(values),
      };
      if (
        Object.values(request).filter((value) => value !== undefined).length < 2
      )
        invalid('Supply at least one route change.');
      return {
        method: 'updateRoute',
        request,
        text: (response) =>
          table([routeLine((response.route as Row | undefined) ?? {})]),
      };
    },
  },
  'route delete': {
    ...id,
    build: ([routeId]) => ({
      method: 'deleteRoute',
      request: { id: routeId },
      text: done('Route deleted.'),
    }),
  },
  'response-route list': {
    positionals: [],
    options: { limit: { type: 'string' }, cursor: { type: 'string' } },
    build: (_positionals, values) => ({
      method: 'listResponseRoutes',
      request: { cursor: str(values, 'cursor'), limit: pageLimit(values) },
      text: (response) =>
        page(table(rows(response.routes).map(responseRouteLine)), response),
    }),
  },
  'response-route create': {
    positionals: [],
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      kind: { type: 'string' },
      destination: { type: 'string' },
      agent: { type: 'boolean' },
      'agent-session': { type: 'string' },
      'agent-instructions': { type: 'string' },
      name: { type: 'string' },
      disabled: { type: 'boolean' },
    },
    build: (_positionals, values) => {
      const agent = values.agent === true;
      const type = sourceType(str(values, 'source-type'), [
        'app',
        'channel',
        'any',
      ]);
      if (!type) invalid('Supply --source-type app, channel or any.');
      if (type === 'any' && values.source !== undefined)
        invalid('--source cannot be combined with --source-type any.');
      const destinationId = str(values, 'destination');
      if (destinationId && agent)
        invalid('Use either --destination <id> or --agent, not both.');
      if (!destinationId && !agent)
        invalid('Supply --destination <id> or --agent.');
      const agentSessionId = str(values, 'agent-session');
      const agentInstructions = str(values, 'agent-instructions');
      if (
        !agent &&
        (agentSessionId !== undefined || agentInstructions !== undefined)
      )
        invalid('--agent-session and --agent-instructions need --agent.');
      return {
        method: 'createResponseRoute',
        request: {
          name: str(values, 'name'),
          sourceType: type,
          sourceId: str(values, 'source'),
          kind: str(values, 'kind'),
          destinationId,
          agent,
          agentSessionId,
          agentInstructions,
          enabled: values.disabled ? false : undefined,
        },
        text: (response) =>
          table([responseRouteLine((response.route as Row | undefined) ?? {})]),
      };
    },
  },
  'response-route update': {
    ...id,
    options: {
      'source-type': { type: 'string' },
      source: { type: 'string' },
      'any-source': { type: 'boolean' },
      kind: { type: 'string' },
      'any-kind': { type: 'boolean' },
      destination: { type: 'string' },
      agent: { type: 'boolean' },
      'agent-session': { type: 'string' },
      'chat-per-notification': { type: 'boolean' },
      'agent-instructions': { type: 'string' },
      'clear-agent-instructions': { type: 'boolean' },
      name: { type: 'string' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    },
    build: ([routeId], values) => {
      exclusive(values, 'source', 'any-source');
      exclusive(values, 'kind', 'any-kind');
      exclusive(values, 'agent-session', 'chat-per-notification');
      exclusive(values, 'agent-instructions', 'clear-agent-instructions');
      const agent = values.agent === true;
      if (agent && values.destination !== undefined)
        invalid('Use either --destination <id> or --agent, not both.');
      const agentSessionId = values['chat-per-notification']
        ? ''
        : str(values, 'agent-session');
      const agentInstructions = values['clear-agent-instructions']
        ? ''
        : str(values, 'agent-instructions');
      if (
        values.destination !== undefined &&
        (agentSessionId !== undefined || agentInstructions !== undefined)
      )
        invalid(
          'Agent options cannot be combined with --destination; the route would go to the destination.',
        );
      const request = {
        id: routeId,
        name: str(values, 'name'),
        sourceType: sourceType(str(values, 'source-type'), [
          'app',
          'channel',
          'any',
        ]),
        // Empty strings clear the filter server-side ("any").
        sourceId: values['any-source'] ? '' : str(values, 'source'),
        kind: values['any-kind'] ? '' : str(values, 'kind'),
        destinationId: str(values, 'destination'),
        agent: agent || undefined,
        agentSessionId,
        agentInstructions,
        enabled: enabledFlag(values),
      };
      if (
        Object.values(request).filter((value) => value !== undefined).length < 2
      )
        invalid('Supply at least one response route change.');
      return {
        method: 'updateResponseRoute',
        request,
        text: (response) =>
          table([responseRouteLine((response.route as Row | undefined) ?? {})]),
      };
    },
  },
  'response-route delete': {
    ...id,
    build: ([routeId]) => ({
      method: 'deleteResponseRoute',
      request: { id: routeId },
      text: done('Response route deleted.'),
    }),
  },
  'channel list': {
    positionals: [],
    build: () => ({
      method: 'listChannels',
      request: {},
      text: (response) =>
        table(
          rows(response.channels).map((row) => [
            field(row, 'id'),
            row.enabled === false ? 'disabled' : 'enabled',
            field(row, 'name'),
            rows(row.kinds)
              .map((kind) => field(kind, 'kind'))
              .join(', '),
            field(row, 'pushUrl'),
          ]),
        ),
    }),
  },
  'channel create': {
    positionals: [],
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string', multiple: true },
      'kind-description': { type: 'string', multiple: true },
    },
    build: (_positionals, values) => {
      const name = str(values, 'name');
      const kinds = list(values, 'kind') ?? [];
      if (!name || kinds.length === 0)
        invalid('Supply --name and at least one --kind <kind>[:<name>].');
      return {
        method: 'createChannel',
        request: {
          name,
          description: str(values, 'description'),
          kinds: {
            kinds: parseKindList(kinds, list(values, 'kind-description') ?? []),
          },
        },
        text: (response) => channelSecret(response, 'Token'),
      };
    },
  },
  'channel update': {
    ...id,
    options: {
      name: { type: 'string' },
      description: { type: 'string' },
      kind: { type: 'string', multiple: true },
      'kind-description': { type: 'string', multiple: true },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    },
    build: ([channelId], values) => {
      const kinds = list(values, 'kind');
      const descriptions = list(values, 'kind-description');
      if (descriptions && !kinds)
        invalid(
          '--kind-description needs the full --kind list; --kind replaces every kind.',
        );
      const request = {
        id: channelId,
        name: str(values, 'name'),
        description: str(values, 'description'),
        kinds: kinds
          ? { kinds: parseKindList(kinds, descriptions ?? []) }
          : undefined,
        enabled: enabledFlag(values),
      };
      if (
        Object.values(request).filter((value) => value !== undefined).length < 2
      )
        invalid('Supply at least one channel change.');
      return {
        method: 'updateChannel',
        request,
        text: done('Channel updated.'),
      };
    },
  },
  'channel rotate-token': {
    ...id,
    build: ([channelId]) => ({
      method: 'rotateChannelToken',
      request: { id: channelId },
      text: (response) => channelSecret(response, 'New token'),
    }),
  },
  'channel delete': {
    ...id,
    build: ([channelId]) => ({
      method: 'deleteChannel',
      request: { id: channelId },
      text: done('Channel deleted.'),
    }),
  },
};

/** Subcommand groups with their own verbs (`notification route create`). */
const GROUPS = [
  'destination',
  'webhook',
  'group',
  'route',
  'response-route',
  'channel',
];

const globalFlags = {
  json: { type: 'boolean' },
  profile: { type: 'string' },
  config: { type: 'string' },
  timeout: { type: 'string' },
  workdir: { type: 'string' },
} as const;

export function notificationCommandKeys(): string[] {
  return Object.keys(specs);
}

/**
 * Resolve `args` (the full argv, `offset` at "notification") into one RPC
 * call. Throws `CliError('invalid_arguments')` for any malformed input.
 */
export function parseNotificationCommand(
  args: readonly string[],
  offset: number,
): { call: NotificationCall; values: Values } {
  const first = args[offset + 1];
  const grouped = first !== undefined && GROUPS.includes(first);
  const key = grouped ? `${first} ${args[offset + 2] ?? ''}` : (first ?? '');
  const spec = specs[key];
  if (!spec)
    throw new CliError('unknown_command', 'Unknown command. Use hatch help.');
  const consumed = grouped ? 3 : 2;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + consumed)],
      options: { ...globalFlags, ...spec.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // Node names the offending flag, e.g. "--priority=-1" for a value that
    // starts with a dash.
    const detail =
      error instanceof Error ? ` ${error.message.replaceAll('\n', ' ')}` : '';
    invalid(
      `Invalid notification arguments.${detail} Use hatch help notification.`,
    );
  }
  const positionals = parsed.positionals;
  if (
    positionals.length !== spec.positionals.length ||
    positionals.some((value) => !value || value.startsWith('-'))
  )
    invalid(
      spec.positionals.length === 0
        ? 'This command takes no positional arguments.'
        : `Supply ${spec.positionals.map((name) => `<${name}>`).join(' ')}.`,
    );
  const values = parsed.values as Values;
  return { call: spec.build(positionals, values), values };
}

/** Execute a resolved call; JSON output is the RPC response in proto JSON. */
export async function executeNotificationCall(
  transport: Transport,
  call: NotificationCall,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ json: JsonValue; text: string }> {
  const client = createClient(
    NotificationService,
    transport,
  ) as unknown as Record<
    Method,
    (request: Record<string, unknown>) => Promise<unknown>
  >;
  const request = Object.fromEntries(
    Object.entries({
      ...call.request,
      ...(call.prepare ? await call.prepare(signal) : {}),
    }).filter(([, value]) => value !== undefined),
  );
  const response = await client[call.method](request);
  const json = toJson(
    NotificationService.method[call.method].output,
    response as never,
    { alwaysEmitImplicit: true },
  );
  return {
    json,
    text: call.text(json as Record<string, unknown>),
  };
}

export async function runNotification(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { call, values } = parseNotificationCommand(args, offset);
  const seconds =
    values.timeout === undefined ? 30 : Number(values.timeout as string);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    values.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(values.profile))
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if (values.config === '')
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, values.config as string | undefined),
    values.profile as string | undefined,
  );
  const result = await executeNotificationCall(
    platformTransport(credential, Math.ceil(seconds * 1000), signal),
    call,
    signal,
  );
  process.stdout.write(
    values.json ? `${JSON.stringify(result.json)}\n` : `${result.text}\n`,
  );
}
