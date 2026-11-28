/**
 * The decisions behind the notification content renderer that need no
 * React Native: which types it draws, how unknown ones fall back, how flow
 * content splits into paragraphs, how buttons stack on a phone, and the
 * numbers behind charts, code and times. `notification-card.tsx` draws what
 * this decides.
 */
import {
  hasInlineInputs,
  inlineText,
  isNode,
  nodeChildren,
  propBool,
  propNumber,
  propString,
  type CardIconName,
  type ContentChild,
  type ContentNode,
} from '../../../packages/hatch-platform-api/notification-content';
import {
  DEFAULT_TEXT_MAX_LENGTH,
  defaultAnswers,
  submitsWithButtons,
  type ReplyAnswers,
  type ReplyField,
  type ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import type { GlyphName } from './glyph.types';

/** Components drawn among blocks. */
export const BLOCK_TYPES = [
  'Card',
  'Document',
  'Column',
  'Row',
  'Grid',
  'Box',
  'Divider',
  'Spacer',
  'Collapse',
  'Title',
  'Text',
  'Caption',
  'Markdown',
  'Badge',
  'Icon',
  'Progress',
  'Stat',
  'Fields',
  'Steps',
  'List',
  'Table',
  'Quote',
  'Code',
  'Trend',
  'Callout',
  'Choice',
  'Buttons',
  'Button',
  'Input',
  'Submit',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Marks drawn inside a paragraph, as nested text. */
export const INLINE_TYPES = [
  'b',
  'i',
  's',
  'code',
  'a',
  'time',
  'br',
  'Badge',
  'Icon',
] as const;
export type InlineType = (typeof INLINE_TYPES)[number];

/** Parts their parent draws, by parent. */
export const PART_TYPES: Readonly<Record<string, string>> = {
  Field: 'Fields',
  Step: 'Steps',
  Item: 'List',
  Tr: 'Table',
  Th: 'Tr',
  Td: 'Tr',
  Option: 'Choice',
};

const BLOCKS = new Set<string>(BLOCK_TYPES);
const INLINES = new Set<string>(INLINE_TYPES);
/** Inline types that never sit among blocks on their own. */
const MARKS = new Set(['b', 'i', 's', 'code', 'a', 'time', 'br']);
const MARKERS = new Set(['Badge', 'Icon']);

export function isKnownType(type: string): boolean {
  return BLOCKS.has(type) || INLINES.has(type) || type in PART_TYPES;
}

/**
 * Children as the renderer draws them. A type this build does not know is a
 * container if it holds anything (its children take its place) and is
 * skipped otherwise, so content from a newer platform still reads.
 */
export function resolveChildren(
  children: readonly ContentChild[],
): ContentChild[] {
  const out: ContentChild[] = [];
  for (const child of children) {
    if (!isNode(child) || isKnownType(child.type)) {
      out.push(child);
      continue;
    }
    out.push(...resolveChildren(nodeChildren(child)));
  }
  return out;
}

export type FlowGroup =
  /** Text and marks read as one paragraph. */
  | { kind: 'inline'; children: ContentChild[] }
  /** Badges and icons on their own, laid out in a row. */
  | { kind: 'markers'; children: ContentNode[] }
  | { kind: 'block'; node: ContentNode };

/**
 * Content split into paragraphs and blocks: each run of text and inline
 * marks is one paragraph; anything else is a block of its own.
 */
export function flowGroups(children: readonly ContentChild[]): FlowGroup[] {
  const groups: FlowGroup[] = [];
  let run: ContentChild[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const nodes = run.filter(isNode);
    const hasText = run.some(
      (child) => typeof child === 'string' && child.trim() !== '',
    );
    if (
      !hasText &&
      nodes.length > 0 &&
      nodes.every((n) => MARKERS.has(n.type))
    ) {
      groups.push({ kind: 'markers', children: nodes });
    } else if (hasText || nodes.length > 0) {
      groups.push({ kind: 'inline', children: run });
    }
    run = [];
  };
  for (const child of resolveChildren(children)) {
    if (
      typeof child === 'string' ||
      MARKS.has(child.type) ||
      MARKERS.has(child.type)
    ) {
      run.push(child);
      continue;
    }
    flush();
    groups.push({ kind: 'block', node: child });
  }
  flush();
  return groups;
}

export type ButtonItem =
  | {
      kind: 'answer';
      /** The `Buttons` the button belongs to. */
      field: ContentNode;
      fieldId: string;
      optionId: string;
      primary: boolean;
    }
  | { kind: 'submit'; node: ContentNode }
  | { kind: 'link'; node: ContentNode; href: string };

/** Whether a row or column lays out buttons. */
export function holdsButtons(node: ContentNode): boolean {
  return resolveChildren(nodeChildren(node)).some(
    (child) =>
      isNode(child) &&
      (child.type === 'Buttons' ||
        child.type === 'Button' ||
        child.type === 'Submit'),
  );
}

/**
 * A row's buttons as the phone stacks them, one per line: the main actions
 * first (primary answers and the submit button), then the other answers,
 * links last. `others` are the row's other children, drawn above them, and
 * `questions` the buttons fields whose label or help needs showing.
 */
export function stackButtons(children: readonly ContentChild[]): {
  questions: ContentNode[];
  buttons: ButtonItem[];
  others: ContentChild[];
} {
  const questions: ContentNode[] = [];
  const items: ButtonItem[] = [];
  const others: ContentChild[] = [];
  const take = (node: ContentNode, field: ContentNode | null) => {
    const href = propString(node, 'href');
    const optionId = propString(node, 'id');
    const fieldId = field ? propString(field, 'id') : undefined;
    if (href) items.push({ kind: 'link', node, href });
    else if (field && fieldId && optionId) {
      items.push({
        kind: 'answer',
        field,
        fieldId,
        optionId,
        primary: propBool(node, 'primary'),
      });
    }
  };
  for (const child of resolveChildren(children)) {
    if (!isNode(child)) {
      others.push(child);
    } else if (child.type === 'Buttons') {
      if (propString(child, 'label') || propString(child, 'description')) {
        questions.push(child);
      }
      for (const button of resolveChildren(nodeChildren(child))) {
        if (isNode(button) && button.type === 'Button') take(button, child);
      }
    } else if (child.type === 'Button') {
      take(child, null);
    } else if (child.type === 'Submit') {
      items.push({ kind: 'submit', node: child });
    } else {
      others.push(child);
    }
  }
  const rank = (item: ButtonItem) =>
    item.kind === 'submit' || (item.kind === 'answer' && item.primary)
      ? 0
      : item.kind === 'answer'
        ? 1
        : 2;
  // Array sort is stable: equal ranks keep the sender's order.
  return {
    questions,
    buttons: [...items].sort((a, b) => rank(a) - rank(b)),
    others,
  };
}

/** How the card takes its inline answers, or null when it asks nothing. */
export function inlineForm(
  content: ContentNode | null,
  reply: ReplyForm | null,
): { addSubmit: boolean } | null {
  if (!content || !reply || !hasInlineInputs(content)) return null;
  let hasSubmit = false;
  const visit = (node: ContentNode) => {
    if (node.type === 'Submit') hasSubmit = true;
    for (const child of nodeChildren(node)) if (isNode(child)) visit(child);
  };
  visit(content);
  return { addSubmit: !hasSubmit && !submitsWithButtons(reply) };
}

export type DiffLine = 'added' | 'removed' | 'hunk' | 'plain';

/** The lines of a code block; a diff colours added and removed ones. */
export function codeLines(
  node: ContentNode,
): { text: string; kind: DiffLine }[] {
  const diff = propString(node, 'language') === 'diff';
  return inlineText(nodeChildren(node))
    .split('\n')
    .map((text) => ({
      text,
      kind: !diff
        ? 'plain'
        : text.startsWith('@@')
          ? 'hunk'
          : text.startsWith('+') && !text.startsWith('+++')
            ? 'added'
            : text.startsWith('-') && !text.startsWith('---')
              ? 'removed'
              : 'plain',
    }));
}

/** Bar heights as a share of the tallest value (or the threshold). */
export function trendBars(
  values: readonly number[],
  threshold: number | undefined,
): {
  bars: { value: number; ratio: number; over: boolean }[];
  threshold: number | null;
} {
  const top = Math.max(0, ...values, threshold ?? 0);
  const ratio = (value: number) =>
    top > 0 ? Math.min(1, Math.max(0, value / top)) : 0;
  return {
    bars: values.map((value) => ({
      value,
      ratio: ratio(value),
      over: threshold !== undefined && value > threshold,
    })),
    threshold: threshold === undefined ? null : ratio(threshold),
  };
}

/** Columns a grid fits in its width, never more than the sender asked. */
export function gridColumns(
  width: number,
  columns: number,
  gap: number,
  minColumn = 88,
): number {
  if (width <= 0) return columns;
  const fit = Math.floor((width + gap) / (minColumn + gap));
  return Math.max(1, Math.min(columns, fit));
}

/**
 * A time in the reader's language and time zone. `step` shows only the time
 * on the day it happened, and the date too otherwise.
 */
export function contentTime(
  iso: string,
  format: 'datetime' | 'date' | 'time' | 'step',
  now: Date = new Date(),
  locale?: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === now.toDateString();
  // Component options rather than date and time styles, which not every
  // JavaScript engine the app runs on formats.
  const day: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  };
  const time: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
  };
  const options =
    format === 'date'
      ? day
      : format === 'time' || (format === 'step' && sameDay)
        ? time
        : { ...day, ...time };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** The symbol each card icon shows in place of the source tile. */
export const CARD_ICON_GLYPHS: Record<CardIconName, GlyphName> = {
  agent: 'agent',
  app: 'apps',
  pr: 'pullRequest',
  deploy: 'deploy',
  task: 'task',
  alert: 'warning',
  shield: 'shield',
  chart: 'chart',
  clock: 'clock',
  database: 'database',
  bug: 'bug',
  message: 'message',
  package: 'package',
  money: 'money',
};

/** A card icon's glyph, if the name is one this build knows. */
export function cardIconGlyph(name: unknown): GlyphName | null {
  return typeof name === 'string' && Object.hasOwn(CARD_ICON_GLYPHS, name)
    ? CARD_ICON_GLYPHS[name as CardIconName]
    : null;
}

/**
 * The question an inline input asks: the notification's own reply field of
 * that id, which a live form can answer (`bound`), else the question the
 * tree declares, drawn read-only.
 */
export function inlineField(
  node: ContentNode,
  reply: ReplyForm | null,
): { field: ReplyField | null; bound: boolean } {
  const id = propString(node, 'id');
  const bound = id ? reply?.fields.find((field) => field.id === id) : undefined;
  return bound
    ? { field: bound, bound: true }
    : { field: fieldFromTree(node), bound: false };
}

/**
 * What a read-only question shows: the round's answer once someone gave
 * it, else the sender's defaults, as a card nobody has answered yet shows
 * them everywhere.
 */
export function shownAnswers(
  field: ReplyField,
  chosen: ReplyAnswers | null,
): ReplyAnswers {
  return chosen ?? defaultAnswers({ fields: [field], submitLabel: '' });
}

/**
 * The question an inline input asks, read from the tree: for drawing it
 * read-only where no reply form is bound to the card.
 */
export function fieldFromTree(node: ContentNode): ReplyField | null {
  const id = propString(node, 'id');
  if (!id) return null;
  const base = {
    id,
    label: propString(node, 'label') ?? '',
    ...(propString(node, 'description')
      ? { description: propString(node, 'description') }
      : {}),
  };
  const options = resolveChildren(nodeChildren(node)).filter(isNode);
  const option = (child: ContentNode) => ({
    id: propString(child, 'id') ?? '',
    label: inlineText(nodeChildren(child)),
  });
  switch (node.type) {
    case 'Choice': {
      const choices = options
        .filter((child) => child.type === 'Option' && propString(child, 'id'))
        .map((child) => ({
          ...option(child),
          ...(propString(child, 'note')
            ? { note: propString(child, 'note') }
            : {}),
          ...(propString(child, 'badge')
            ? { badge: propString(child, 'badge') }
            : {}),
        }));
      const required = propBool(node, 'required');
      const defaults = options
        .filter(
          (child) => child.type === 'Option' && propBool(child, 'default'),
        )
        .map((child) => propString(child, 'id') ?? '');
      return propBool(node, 'multiple')
        ? {
            ...base,
            type: 'multiple',
            required,
            options: choices,
            minSelected: propNumber(node, 'min') ?? 1,
            maxSelected: propNumber(node, 'max') ?? choices.length,
            ...(defaults.length > 0 ? { default: defaults } : {}),
          }
        : {
            ...base,
            type: 'single',
            required,
            options: choices,
            ...(defaults[0] ? { default: defaults[0] } : {}),
          };
    }
    case 'Buttons':
      return {
        ...base,
        type: 'buttons',
        required: true,
        options: options
          .filter((child) => child.type === 'Button' && propString(child, 'id'))
          .map((child) => ({
            ...option(child),
            ...(propBool(child, 'primary') ? { primary: true as const } : {}),
            ...(propBool(child, 'destructive')
              ? { destructive: true as const }
              : {}),
          })),
      };
    case 'Input':
      return {
        ...base,
        type: 'text',
        required: propBool(node, 'required'),
        ...(propString(node, 'placeholder')
          ? { placeholder: propString(node, 'placeholder') }
          : {}),
        multiline: propBool(node, 'multiline'),
        maxLength: propNumber(node, 'max-length') ?? DEFAULT_TEXT_MAX_LENGTH,
      };
    default:
      return null;
  }
}
