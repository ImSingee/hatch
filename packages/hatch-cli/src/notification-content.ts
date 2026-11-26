/**
 * Notification content in the CLI: the text / Markdown / card flags of
 * `notification send|update`, checked locally with the platform's compilers
 * before any request; the content lines `get` prints; and the offline
 * `notification card check|catalog`.
 */
import {
  ContentError,
  compileCard,
  compileCardMarkup,
  compileCardTree,
  compileMarkdown,
  formatContentIssue,
  summarySchema,
  type CompiledCard,
  type ContentIssue,
} from '../../hatch-platform-api/notification-content-schema';
import {
  CARD_ROOT,
  CONTENT_COMPONENTS,
  DOCUMENT_ROOT,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_DEPTH,
  MAX_CONTENT_NODES,
  MAX_SUMMARY_LENGTH,
  notificationHeadline,
  type ComponentCategory,
  type ComponentSpec,
  type ContentNode,
  type PropSpec,
} from '../../hatch-platform-api/notification-content';
import {
  contentToMarkup,
  contentToPlainText,
} from '../../hatch-platform-api/notification-content-text';
import type { ReplyForm } from '../../hatch-platform-api/notification-reply';
import { CliError } from './error';
import { readTextInput } from './input';

type Values = Record<string, string | boolean | string[] | undefined>;
type Row = Record<string, unknown>;

/**
 * `--*-file` content is read up to this, the size the compilers accept as
 * sent (a card's content and Markdown are then held to 16 KiB).
 */
export const CONTENT_INPUT_MAX_BYTES = 64 * 1024;

const CATALOG_HINT = 'Components and props: hatch notification card catalog.';

function invalid(message: string): never {
  throw new CliError('invalid_arguments', message);
}

const str = (values: Values, flag: string) => {
  const value = values[flag];
  return typeof value === 'string' ? value : undefined;
};

const field = (row: Row | undefined, key: string) =>
  row?.[key] === undefined || row[key] === null ? '' : String(row[key]);

/**
 * Content the platform would reject: `invalid_content` (exit 2), its
 * message naming the source flag and each problem as `line:column` (markup)
 * or a path (JSON tree). `details.issues` carries them as data.
 */
export function contentError(
  source: string,
  issues: readonly ContentIssue[],
  hint = true,
): CliError {
  const lines = issues.map(formatContentIssue);
  const message =
    lines.length === 1
      ? `${source}: ${lines[0]}`
      : `${source}:\n${lines.map((line) => `  ${line}`).join('\n')}`;
  return new CliError(
    'invalid_content',
    hint ? `${message}\n${CATALOG_HINT}` : message,
    2,
    undefined,
    { flag: source, issues },
  );
}

function compiled<T>(source: string, hint: boolean, compile: () => T): T {
  try {
    return compile();
  } catch (error) {
    if (error instanceof ContentError)
      throw contentError(source, error.issues, hint);
    throw error;
  }
}

// ----------------------------------------------------------------- summary

/** `--summary`: one plain line, at most 200 characters, trimmed. */
export function parseSummary(text: string, mode: 'send' | 'update'): string {
  if (!text.trim())
    invalid(
      mode === 'update'
        ? '--summary cannot be empty; use --clear-summary to remove it.'
        : '--summary cannot be empty.',
    );
  const parsed = summarySchema.safeParse(text);
  // The schema's messages start with "summary must …".
  if (!parsed.success)
    invalid(`--${parsed.error.issues[0]?.message ?? 'summary is invalid'}.`);
  return parsed.data;
}

// -------------------------------------------------------------------- card

/** A `--card` value, by its shape. */
export type CardFlagValue =
  | { shape: 'markup'; markup: string; reply: ReplyForm | null }
  | { shape: 'tree'; json: string; reply: ReplyForm | null };

/**
 * Read a card as given to `--card`/`--card-file`: text whose first
 * non-space character is `{` is a JSON render tree; anything else is
 * markup. Both are compiled as the platform will compile them.
 */
export function readCardFlag(text: string, flag: string): CardFlagValue {
  const trimmed = text.trim();
  if (!trimmed) invalid(`--${flag} cannot be empty.`);
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw contentError(
        `--${flag}`,
        [{ message: 'starts with "{" but is not valid JSON' }],
        false,
      );
    }
    const card = compiled(`--${flag}`, true, () => compileCardTree(parsed));
    return { shape: 'tree', json: trimmed, reply: card.reply };
  }
  const card = compiled(`--${flag}`, true, () => compileCardMarkup(text));
  return { shape: 'markup', markup: text, reply: card.reply };
}

// ----------------------------------------------------------------- content

export type ContentPlan = {
  /** Request fields known from the arguments alone. */
  request: Record<string, unknown>;
  /** Reads a `--*-file` content input and checks it. */
  load?: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  /** Whether any content flag was given (update's change guard). */
  changes: boolean;
};

const flags = (names: readonly string[]) =>
  names.map((name) => `--${name}`).join(', ');

/**
 * The content of `send` or `update`: exactly one of text (`--title`,
 * `--body`), Markdown (`--markdown`/`--markdown-file`) or a card
 * (`--card`/`--card-file`), plus `--summary` (and on update
 * `--clear-summary`, `--clear-body`). Everything that can
 * be checked is checked here or, for files, in `load`, before any request.
 *
 * `hasReplyForm`: `--reply`/`--reply-file` is given; a card with inline
 * inputs makes its own form and cannot be combined with one.
 */
export function contentPlan(
  values: Values,
  mode: 'send' | 'update',
  hasReplyForm: boolean,
): ContentPlan {
  const update = mode === 'update';
  const given = (flag: string) =>
    values[flag] !== undefined && values[flag] !== false;
  for (const [a, b] of [
    ['markdown', 'markdown-file'],
    ['card', 'card-file'],
  ])
    if (given(a) && given(b)) invalid(`Use only one of --${a}, --${b}.`);
  const stdin = ['markdown-file', 'card-file', 'reply-file'].filter(
    (flag) => values[flag] === '-',
  );
  if (stdin.length > 1)
    invalid(
      `Only one input can be read from stdin; ${flags(stdin)} all use -.`,
    );
  for (const flag of ['markdown-file', 'card-file'])
    if (values[flag] === '') invalid(`--${flag} needs a path or -.`);

  const markdownFlag = given('markdown')
    ? 'markdown'
    : given('markdown-file')
      ? 'markdown-file'
      : undefined;
  const cardFlag = given('card')
    ? 'card'
    : given('card-file')
      ? 'card-file'
      : undefined;
  if (markdownFlag && cardFlag)
    invalid(
      `Use only one kind of content: --title [--body], --markdown/--markdown-file or --card/--card-file.`,
    );

  const title = str(values, 'title');
  const textFlags = ['title', 'body', ...(update ? ['clear-body'] : [])].filter(
    given,
  );
  const summaryText = str(values, 'summary');
  const clearSummary = update && values['clear-summary'] === true;
  if (clearSummary && summaryText !== undefined)
    invalid('Use either --summary or --clear-summary, not both.');
  const summary =
    summaryText === undefined ? undefined : parseSummary(summaryText, mode);

  const request: Record<string, unknown> = {
    summary,
    ...(update ? { clearSummary: clearSummary || undefined } : {}),
  };
  const changes =
    summary !== undefined || clearSummary || !!markdownFlag || !!cardFlag;
  const needsSummary = (flag: string) =>
    invalid(
      `--${flag} needs --summary: one plain line (at most ${MAX_SUMMARY_LENGTH} characters) that pushes and lists show.`,
    );
  /** Markdown or a card replaces title and body; it has no text summary. */
  const rejectTextFlags = (flag: string) => {
    const conflicts = [
      ...textFlags,
      ...(clearSummary ? ['clear-summary'] : []),
    ];
    if (conflicts.length > 0)
      invalid(
        `--${flag} cannot be combined with ${flags(conflicts)}: Markdown and card content carry their own heading and need a summary.`,
      );
    if (!update && summary === undefined) needsSummary(flag);
  };

  if (title !== undefined && !title.trim()) invalid('--title cannot be empty.');

  if (markdownFlag) {
    rejectTextFlags(markdownFlag);
    const check = (source: string) => {
      compiled(`--${markdownFlag}`, false, () => compileMarkdown(source));
      return source;
    };
    const inline = str(values, 'markdown');
    if (inline !== undefined) request.markdown = check(inline);
    const path = str(values, 'markdown-file');
    return {
      request,
      changes,
      load:
        path === undefined
          ? undefined
          : async (signal) => ({
              markdown: check(
                await readTextInput(path, signal, CONTENT_INPUT_MAX_BYTES),
              ),
            }),
    };
  }

  if (cardFlag) {
    rejectTextFlags(cardFlag);
    const apply = (card: CardFlagValue): Record<string, unknown> => {
      if (card.reply && hasReplyForm)
        invalid(
          `--${cardFlag} has inline inputs (<Choice>, <Buttons> or <Input>), which make its reply form; drop --reply/--reply-file.`,
        );
      return card.shape === 'markup'
        ? { cardMarkup: card.markup }
        : { cardJson: card.json };
    };
    const inline = str(values, 'card');
    if (inline !== undefined)
      Object.assign(request, apply(readCardFlag(inline, 'card')));
    const path = str(values, 'card-file');
    return {
      request,
      changes,
      load:
        path === undefined
          ? undefined
          : async (signal) =>
              apply(
                readCardFlag(
                  await readTextInput(path, signal, CONTENT_INPUT_MAX_BYTES),
                  'card-file',
                ),
              ),
    };
  }

  if (!update) {
    if (title === undefined && given('body')) invalid('--body needs --title.');
    if (title === undefined)
      invalid(
        'Supply the content: --title [--body], --markdown/--markdown-file or --card/--card-file.',
      );
  }
  return { request, changes };
}

// --------------------------------------------------------------- reading

/** `format` of a summary or revision. */
export function formatOf(row: Row | undefined): string {
  return field(row, 'format') || 'text';
}

/** The name the notification goes by: its title, or its summary. */
export function headlineOf(row: Row | undefined): string {
  return notificationHeadline({
    format: formatOf(row),
    title: field(row, 'title') || null,
    summary: field(row, 'summary') || null,
  });
}

/** A stored tree (`content_json`) as canonical markup, when it parses. */
function storedMarkup(row: Row | undefined): string | undefined {
  try {
    const tree = JSON.parse(field(row, 'contentJson')) as ContentNode;
    return tree && typeof tree.type === 'string'
      ? contentToMarkup(tree)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What `get` prints about the content: the format and summary, then the
 * body of a text notification, the source of a Markdown one, or the plain
 * text and canonical markup of a card (edit it and pass it to `--card`).
 */
export function contentLines(row: Row | undefined): string[] {
  const format = formatOf(row);
  const summary = field(row, 'summary');
  const lines = [
    `Format: ${format}`,
    ...(summary ? [`Summary: ${summary}`] : []),
  ];
  if (format === 'markdown')
    return [...lines, '', 'Markdown:', field(row, 'markdown')];
  if (format === 'card')
    return [
      ...lines,
      '',
      'Text:',
      field(row, 'text') || '(none)',
      '',
      'Markup:',
      storedMarkup(row) ?? '(unavailable)',
    ];
  return field(row, 'body') ? [...lines, '', field(row, 'body')] : lines;
}

// ------------------------------------------------------------ card check

export type CardCheck = {
  ok: true;
  /** The plain text pushes and other text-only places use. */
  text: string;
  /** Canonical markup; parsing it gives the same card. */
  markup: string;
  /** The reply form its inline inputs make; null without inputs. */
  reply: ReplyForm | null;
  /** The render tree the platform stores. */
  content: ContentNode;
};

/**
 * Check a card offline: markup, or a JSON tree when the first non-space
 * character is `{`. Problems throw `invalid_content` with one
 * `line:column: message` (or `path: message`) line each.
 */
export function checkCard(input: string): CardCheck {
  if (!input.trim()) invalid('Supply the card: <markup> or --file <path|->.');
  let card: CompiledCard;
  try {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) {
      let tree: unknown;
      try {
        tree = JSON.parse(trimmed);
      } catch {
        throw new ContentError([
          { message: 'card starts with "{" but is not valid JSON' },
        ]);
      }
      card = compileCard(tree);
    } else card = compileCard(input);
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    throw new CliError(
      'invalid_content',
      `${error.issues.map(formatContentIssue).join('\n')}\n${CATALOG_HINT}`,
      2,
      undefined,
      { issues: error.issues },
    );
  }
  return {
    ok: true,
    text: contentToPlainText(card.content),
    markup: contentToMarkup(card.content),
    reply: card.reply,
    content: card.content,
  };
}

/** A reply form as proto JSON (`get`) or as compiled (`card check`). */
export type ReplyFormRow = {
  fields?: {
    id?: string;
    type?: string;
    label?: string;
    required?: boolean;
    options?: { id?: string; label?: string }[];
  }[];
};

/** Reply form fields, one line each; inline buttons may have no label. */
export function replyFormLines(reply: ReplyFormRow | undefined): string[] {
  return (reply?.fields ?? []).map((replyField) => {
    const options = (replyField.options ?? [])
      .map((option) => `${option.id}=${option.label}`)
      .join(', ');
    return `  ${replyField.id} (${replyField.type}${
      replyField.required === false ? ', optional' : ''
    })${replyField.label ? `: ${replyField.label}` : ''}${
      options ? ` — ${options}` : ''
    }`;
  });
}

export function cardCheckText(check: CardCheck): string {
  return [
    'Valid card.',
    '',
    'Plain text:',
    check.text || '(none)',
    '',
    ...(check.reply
      ? [
          `Reply form from its inline inputs (submit: ${check.reply.submitLabel}):`,
          ...replyFormLines(check.reply),
        ]
      : ['Reply form: none (no inline inputs).']),
    '',
    'Canonical markup:',
    check.markup,
  ].join('\n');
}

// ---------------------------------------------------------- card catalog

const CATEGORIES: { category: ComponentCategory; title: string }[] = [
  { category: 'root', title: 'Root' },
  { category: 'layout', title: 'Layout' },
  { category: 'text', title: 'Text' },
  { category: 'inline', title: 'Inline marks' },
  { category: 'marker', title: 'Markers' },
  { category: 'data', title: 'Data' },
  { category: 'input', title: 'Inline inputs (become the reply form)' },
];

/** Components a card may use; `Document` is the Markdown root, never written. */
const CARD_COMPONENTS = CONTENT_COMPONENTS.filter(
  (spec) => spec.name !== DOCUMENT_ROOT,
);

const tagList = (names: readonly string[]) =>
  names.map((name) => `<${name}>`).join(', ');

function placementText(spec: ComponentSpec): string {
  const placement = spec.placement;
  if (Array.isArray(placement)) return `only inside ${tagList(placement)}`;
  switch (placement) {
    case 'root':
      return 'the root of the card';
    case 'block':
      return 'among blocks';
    case 'inline':
      return 'in text';
    default:
      return 'among blocks or in text';
  }
}

function contentText(spec: ComponentSpec): string {
  const content = spec.content;
  if (Array.isArray(content)) return `only ${tagList(content)}`;
  switch (content) {
    case 'blocks':
      return 'blocks (components, no loose text)';
    case 'inline':
      return 'text and inline marks';
    case 'flow':
      return 'text, inline marks and blocks';
    case 'text':
      return 'plain text';
    case 'raw':
      return 'text kept as written, line breaks included';
    default:
      return 'nothing (write it self-closing)';
  }
}

function propTypeText(spec: PropSpec): string {
  switch (spec.type) {
    case 'text':
      return `text, at most ${spec.max} characters`;
    case 'enum':
      return `one of ${spec.values.join(', ')}`;
    case 'bool':
      return 'flag (write it bare, or "true" / "false")';
    case 'int':
      return `whole number ${spec.min}-${spec.max}`;
    case 'number':
      return spec.min !== undefined && spec.max !== undefined
        ? `number ${spec.min}-${spec.max}`
        : spec.min !== undefined
          ? `number, at least ${spec.min}`
          : spec.max !== undefined
            ? `number, at most ${spec.max}`
            : 'number';
    case 'numbers':
      return `${spec.min}-${spec.max} numbers separated by commas`;
    case 'url':
      return 'link (https://, mailto:, hatch://…)';
    case 'datetime':
      return 'ISO-8601 time, such as 2026-11-25T02:14:00Z';
    case 'fieldId':
      return 'answer key: a lowercase letter, then lowercase letters, digits or "_" (at most 40)';
    case 'optionId':
      return 'answer value: 1-40 lowercase letters, digits, "_", "-" or "."';
  }
}

/** The catalog as data: what `card catalog --json` prints. */
export function cardCatalog() {
  return {
    root: CARD_ROOT,
    limits: {
      maxBytes: MAX_CONTENT_BYTES,
      maxElements: MAX_CONTENT_NODES,
      maxDepth: MAX_CONTENT_DEPTH,
      maxSummaryLength: MAX_SUMMARY_LENGTH,
    },
    components: CARD_COMPONENTS.map((spec) => ({
      name: spec.name,
      category: spec.category,
      description: spec.description,
      placement: spec.placement,
      content: spec.content,
      cardOnly: spec.cardOnly === true,
      ...(spec.maxText === undefined ? {} : { maxText: spec.maxText }),
      props: Object.entries(spec.props).map(([name, prop]) => ({
        name,
        ...prop,
        required: prop.required === true,
      })),
    })),
  };
}

export function cardCatalogText(): string {
  const lines = [
    `Card markup: one <${CARD_ROOT}> root holding components (capitalized) and inline marks (lowercase). At most ${MAX_CONTENT_BYTES / 1024} KiB, ${MAX_CONTENT_NODES} elements and ${MAX_CONTENT_DEPTH} levels below <${CARD_ROOT}>. Check a card with hatch notification card check.`,
  ];
  for (const { category, title } of CATEGORIES) {
    const specs = CARD_COMPONENTS.filter((spec) => spec.category === category);
    if (specs.length === 0) continue;
    lines.push('', `${title}:`);
    for (const spec of specs) {
      lines.push(
        '',
        `  <${spec.name}> ${spec.description}`,
        `    goes: ${placementText(spec)}; holds: ${contentText(spec)}${
          spec.maxText === undefined
            ? ''
            : ` (at most ${spec.maxText} characters)`
        }`,
      );
      for (const [name, prop] of Object.entries(spec.props)) {
        const fallback =
          'default' in prop && prop.default !== undefined
            ? `; default ${prop.default}`
            : '';
        lines.push(
          `    ${name}${prop.required ? ' (required)' : ''}: ${propTypeText(prop)}${fallback}. ${prop.description}`,
        );
      }
    }
  }
  return lines.join('\n');
}
