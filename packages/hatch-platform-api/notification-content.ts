/**
 * Notification content: the three formats a notification can take and the
 * render tree Markdown and card markup both compile into. Types, the
 * component catalog, limits and pure helpers shared by the platform, the CLI,
 * the web and the phone, with no dependencies (the phone bundles no zod and
 * no Markdown library). Validation lives in `notification-content-schema`,
 * the markup parser in `notification-card-markup`, the Markdown compiler in
 * `notification-markdown`, and the plain-text and markup serializers in
 * `notification-content-text`.
 *
 * A tree node is `{ type, props?, children? }`; text leaves are strings.
 * Components are capitalized (`Card`, `Steps`), inline marks lowercase (`b`,
 * `a`). Stored trees are normalized: props equal to their default are left
 * out, inline strings never hold a line break (that is a `br` node), and no
 * string is empty. Renderers that meet a type they do not know render a
 * container's children and skip anything else, so older clients keep working
 * when the catalog grows.
 */

export type NotificationFormat = 'text' | 'markdown' | 'card';
export const NOTIFICATION_FORMATS = [
  'text',
  'markdown',
  'card',
] as const satisfies readonly NotificationFormat[];

export type ContentPropValue = string | number | boolean | number[];

export type ContentNode = {
  type: string;
  props?: Record<string, ContentPropValue>;
  children?: ContentChild[];
};

export type ContentChild = ContentNode | string;

/** The root of a card notification's tree. */
export const CARD_ROOT = 'Card';
/** The root of a Markdown notification's tree. */
export const DOCUMENT_ROOT = 'Document';

export const MAX_SUMMARY_LENGTH = 200;
/**
 * A card's content as compact canonical markup, and Markdown source, in
 * UTF-8 bytes.
 */
export const MAX_CONTENT_BYTES = 16 * 1024;
/**
 * Card markup or a JSON tree as sent, in UTF-8 bytes, checked before
 * parsing. Larger than the content limit, so the indented canonical markup
 * of any accepted card can be sent back as it is.
 */
export const MAX_CARD_SOURCE_BYTES = 64 * 1024;
/** Element nodes in one tree, the root included. */
export const MAX_CONTENT_NODES = 200;
/** Nesting below the root. */
export const MAX_CONTENT_DEPTH = 8;
/** Text inside one element, in characters. */
export const MAX_TEXT_LENGTH = 4000;

export type ContentTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'working';
export const CONTENT_TONES = [
  'neutral',
  'info',
  'success',
  'warning',
  'danger',
  'working',
] as const satisfies readonly ContentTone[];

/** Text may also be dimmed; `neutral` is the default ink. */
export const TEXT_TONES = ['dimmed', ...CONTENT_TONES] as const;

export type CardIconName =
  | 'agent'
  | 'app'
  | 'pr'
  | 'deploy'
  | 'task'
  | 'alert'
  | 'shield'
  | 'chart'
  | 'clock'
  | 'database'
  | 'bug'
  | 'message'
  | 'package'
  | 'money';
export const CARD_ICONS = [
  'agent',
  'app',
  'pr',
  'deploy',
  'task',
  'alert',
  'shield',
  'chart',
  'clock',
  'database',
  'bug',
  'message',
  'package',
  'money',
] as const satisfies readonly CardIconName[];

export const SPACINGS = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
export type Spacing = (typeof SPACINGS)[number];

export type StepState = 'done' | 'failed' | 'running' | 'pending' | 'skipped';
export const STEP_STATES = [
  'done',
  'failed',
  'running',
  'pending',
  'skipped',
] as const satisfies readonly StepState[];

// ------------------------------------------------------------------ catalog

export type PropSpec = {
  description: string;
  required?: boolean;
} & (
  | { type: 'text'; max: number; default?: string }
  | { type: 'enum'; values: readonly string[]; default?: string }
  /**
   * A flag: written bare (`mono`) or as `"true"` / `"false"`. Only true is
   * kept, unless `keepFalse` (a task list item that is not done yet).
   */
  | { type: 'bool'; keepFalse?: boolean }
  | { type: 'int'; min: number; max: number; default?: number }
  | { type: 'number'; min?: number; max?: number }
  /** A comma-separated list of numbers. */
  | { type: 'numbers'; min: number; max: number }
  /** A link: the same rule as a notification's `url`. */
  | { type: 'url' }
  /** An ISO-8601 time, shown in the reader's language and time zone. */
  | { type: 'datetime' }
  | { type: 'fieldId' }
  | { type: 'optionId' }
);

/**
 * What an element holds:
 * - `blocks`: other components, no loose text.
 * - `inline`: text and inline marks (`<b>`, `<a>`, `Badge`, …).
 * - `flow`: either; runs of inline content read as paragraphs.
 * - `text`: plain text only.
 * - `raw`: text kept as written, line breaks and spacing included.
 * - `none`: nothing.
 * - a list of component names: only those.
 */
export type ContentModel =
  | 'blocks'
  | 'inline'
  | 'flow'
  | 'text'
  | 'raw'
  | 'none'
  | readonly string[];

export type ComponentCategory =
  | 'root'
  | 'layout'
  | 'text'
  | 'inline'
  | 'marker'
  | 'data'
  | 'input';

export type ComponentSpec = {
  name: string;
  category: ComponentCategory;
  description: string;
  /**
   * Where it may appear: among blocks, in inline content, both, only at the
   * root, or only inside the listed parents.
   */
  placement: 'block' | 'inline' | 'both' | 'root' | readonly string[];
  content: ContentModel;
  /** Props in the order the canonical markup writes them. */
  props: Record<string, PropSpec>;
  /** Text content longer than this is rejected. */
  maxText?: number;
  /** Card markup only: never in Markdown trees. */
  cardOnly?: boolean;
};

const tone = (description: string): PropSpec => ({
  type: 'enum',
  values: CONTENT_TONES,
  default: 'neutral',
  description,
});
const gap: PropSpec = {
  type: 'enum',
  values: SPACINGS,
  description: 'Space between children.',
};
const thenStatus: Record<string, PropSpec> = {
  'then-status': {
    type: 'text',
    max: 24,
    description:
      'Status the card shows once this is chosen, until the sender updates it.',
  },
  'then-tone': tone('Tone of then-status.'),
};
const align = (values: readonly string[]): PropSpec => ({
  type: 'enum',
  values,
  description: 'Alignment.',
});

/** Every component and inline mark, in the order the catalog lists them. */
export const CONTENT_COMPONENTS: readonly ComponentSpec[] = [
  {
    name: 'Card',
    category: 'root',
    description:
      'The card itself. Status, flag and icon are drawn by the platform in fixed places.',
    placement: 'root',
    content: 'blocks',
    props: {
      icon: {
        type: 'enum',
        values: CARD_ICONS,
        description: 'Shown in place of the source tile.',
      },
      status: {
        type: 'text',
        max: 24,
        description: 'Short state shown as a pill, such as "CI failed".',
      },
      tone: tone('Tone of the status.'),
      flag: {
        type: 'text',
        max: 16,
        description: 'Urgent marker beside the status, such as "Urgent".',
      },
    },
    cardOnly: true,
  },
  {
    name: 'Document',
    category: 'root',
    description: 'The root of a Markdown notification.',
    placement: 'root',
    content: 'blocks',
    props: {},
  },
  // Layout
  {
    name: 'Column',
    category: 'layout',
    description: 'Children stacked vertically.',
    placement: 'block',
    content: 'blocks',
    props: { gap, align: align(['start', 'center', 'end', 'stretch']) },
  },
  {
    name: 'Row',
    category: 'layout',
    description:
      'Children side by side; stacks on narrow screens when it holds buttons.',
    placement: 'block',
    content: 'blocks',
    props: {
      gap,
      justify: align(['start', 'center', 'end', 'between']),
      align: align(['start', 'center', 'end', 'baseline', 'stretch']),
      wrap: { type: 'bool', description: 'Wrap children onto more lines.' },
    },
  },
  {
    name: 'Grid',
    category: 'layout',
    description: 'Equal columns.',
    placement: 'block',
    content: 'blocks',
    props: {
      columns: {
        type: 'int',
        min: 2,
        max: 4,
        default: 2,
        description: 'Number of columns, 2-4.',
      },
      gap,
    },
  },
  {
    name: 'Box',
    category: 'layout',
    description: 'A group on a tinted surface.',
    placement: 'block',
    content: 'blocks',
    props: {
      surface: {
        type: 'enum',
        values: ['muted', 'outline'],
        default: 'muted',
        description: 'Muted fill or an outline.',
      },
      padding: {
        type: 'enum',
        values: ['sm', 'md', 'lg'],
        description: 'Inner spacing.',
      },
      tone: tone('Tints the surface.'),
    },
  },
  {
    name: 'Divider',
    category: 'layout',
    description: 'A hairline between sections.',
    placement: 'block',
    content: 'none',
    props: {},
  },
  {
    name: 'Spacer',
    category: 'layout',
    description: 'Extra vertical space.',
    placement: 'block',
    content: 'none',
    props: {
      size: {
        type: 'enum',
        values: SPACINGS,
        default: 'md',
        description: 'How much space.',
      },
    },
  },
  {
    name: 'Collapse',
    category: 'layout',
    description: 'Content hidden behind a toggle until opened.',
    placement: 'block',
    content: 'blocks',
    props: {
      summary: {
        type: 'text',
        max: 100,
        required: true,
        description: 'The toggle label, such as "Show 12 log lines".',
      },
    },
  },
  // Text
  {
    name: 'Title',
    category: 'text',
    description: 'A heading.',
    placement: 'block',
    content: 'inline',
    props: {
      size: {
        type: 'enum',
        values: ['sm', 'md', 'lg', 'xl'],
        default: 'md',
        description: 'Heading size.',
      },
      align: align(['start', 'center', 'end']),
      lines: {
        type: 'int',
        min: 1,
        max: 10,
        description: 'Clamp to this many lines.',
      },
    },
    maxText: 300,
  },
  {
    name: 'Text',
    category: 'text',
    description: 'A paragraph.',
    placement: 'block',
    content: 'inline',
    props: {
      size: {
        type: 'enum',
        values: SPACINGS,
        default: 'md',
        description: 'Text size, xs-xl.',
      },
      weight: {
        type: 'enum',
        values: ['regular', 'medium', 'bold'],
        default: 'regular',
        description: 'Text weight.',
      },
      tone: {
        type: 'enum',
        values: TEXT_TONES,
        default: 'neutral',
        description: 'Ink colour: dimmed or a tone.',
      },
      align: align(['start', 'center', 'end']),
      mono: { type: 'bool', description: 'Monospaced, for identifiers.' },
      lines: {
        type: 'int',
        min: 1,
        max: 10,
        description: 'Clamp to this many lines.',
      },
    },
  },
  {
    name: 'Caption',
    category: 'text',
    description: 'Small dimmed text, such as "Updated 10:52".',
    placement: 'block',
    content: 'inline',
    props: {
      tone: {
        type: 'enum',
        values: TEXT_TONES,
        default: 'dimmed',
        description: 'Ink colour.',
      },
      align: align(['start', 'center', 'end']),
      lines: {
        type: 'int',
        min: 1,
        max: 10,
        description: 'Clamp to this many lines.',
      },
    },
  },
  {
    name: 'Markdown',
    category: 'text',
    description:
      'Markdown inside a card: headings, emphasis, lists, quotes, code, links and tables.',
    placement: 'block',
    content: 'raw',
    props: {},
    cardOnly: true,
  },
  // Inline marks
  {
    name: 'b',
    category: 'inline',
    description: 'Bold.',
    placement: 'inline',
    content: 'inline',
    props: {},
  },
  {
    name: 'i',
    category: 'inline',
    description: 'Italic.',
    placement: 'inline',
    content: 'inline',
    props: {},
  },
  {
    name: 's',
    category: 'inline',
    description: 'Struck through.',
    placement: 'inline',
    content: 'inline',
    props: {},
  },
  {
    name: 'code',
    category: 'inline',
    description: 'Inline code.',
    placement: 'inline',
    content: 'text',
    props: {},
  },
  {
    name: 'a',
    category: 'inline',
    description: 'A link; opened only when tapped.',
    placement: 'inline',
    content: 'inline',
    props: {
      href: {
        type: 'url',
        required: true,
        description: 'http(s), another app or a hatch:// page.',
      },
    },
  },
  {
    name: 'time',
    category: 'inline',
    description: "A time shown in the reader's language and time zone.",
    placement: 'inline',
    content: 'none',
    props: {
      datetime: {
        type: 'datetime',
        required: true,
        description: 'ISO-8601 time.',
      },
      format: {
        type: 'enum',
        values: ['datetime', 'date', 'time'],
        default: 'datetime',
        description: 'What to show.',
      },
    },
  },
  {
    name: 'br',
    category: 'inline',
    description: 'A line break.',
    placement: 'inline',
    content: 'none',
    props: {},
  },
  // Markers
  {
    name: 'Badge',
    category: 'marker',
    description: 'A small tinted label.',
    placement: 'both',
    content: 'text',
    props: { tone: tone('Badge tone.') },
    maxText: 40,
  },
  {
    name: 'Icon',
    category: 'marker',
    description: 'An icon from the fixed set.',
    placement: 'both',
    content: 'none',
    props: {
      name: {
        type: 'enum',
        values: CARD_ICONS,
        required: true,
        description: 'Icon name.',
      },
      tone: tone('Icon tone.'),
    },
  },
  // Data
  {
    name: 'Progress',
    category: 'data',
    description: 'A bar filled to percent.',
    placement: 'block',
    content: 'none',
    props: {
      label: { type: 'text', max: 100, description: 'What is measured.' },
      value: { type: 'text', max: 40, description: 'Such as "3 / 14".' },
      percent: {
        type: 'number',
        min: 0,
        max: 100,
        required: true,
        description: '0-100.',
      },
      tone: tone('Bar tone.'),
    },
  },
  {
    name: 'Stat',
    category: 'data',
    description: 'One figure with its label.',
    placement: 'block',
    content: 'none',
    props: {
      value: {
        type: 'text',
        max: 40,
        required: true,
        description: 'The figure.',
      },
      label: {
        type: 'text',
        max: 60,
        required: true,
        description: 'What it counts.',
      },
      delta: { type: 'text', max: 24, description: 'Change, such as "+62%".' },
      tone: tone('Tone of the delta.'),
    },
  },
  {
    name: 'Fields',
    category: 'data',
    description: 'Label and value pairs.',
    placement: 'block',
    content: ['Field'],
    props: {
      mono: { type: 'bool', description: 'Monospaced values.' },
    },
  },
  {
    name: 'Field',
    category: 'data',
    description: 'One label and its value.',
    placement: ['Fields'],
    content: 'inline',
    props: {
      label: {
        type: 'text',
        max: 60,
        required: true,
        description: 'The label.',
      },
      mono: { type: 'bool', description: 'Monospaced value.' },
    },
    maxText: 500,
  },
  {
    name: 'Steps',
    category: 'data',
    description: 'A checklist of steps or checks.',
    placement: 'block',
    content: ['Step'],
    props: {
      mono: {
        type: 'bool',
        description: 'Monospaced names in an outlined list, for checks.',
      },
    },
  },
  {
    name: 'Step',
    category: 'data',
    description: 'One step.',
    placement: ['Steps'],
    content: 'inline',
    props: {
      state: {
        type: 'enum',
        values: STEP_STATES,
        default: 'pending',
        description: 'done, failed, running, pending or skipped.',
      },
      detail: {
        type: 'text',
        max: 60,
        description: 'Shown at the end, such as "2m 14s".',
      },
      at: {
        type: 'datetime',
        description: 'When it happened; shown as a time.',
      },
      href: { type: 'url', description: 'Opens the step, such as its log.' },
    },
    maxText: 300,
  },
  {
    name: 'List',
    category: 'data',
    description: 'A bulleted, numbered or task list.',
    placement: 'block',
    content: ['Item'],
    props: { ordered: { type: 'bool', description: 'Numbered.' } },
  },
  {
    name: 'Item',
    category: 'data',
    description: 'One list item.',
    placement: ['List'],
    content: 'flow',
    props: {
      checked: {
        type: 'bool',
        keepFalse: true,
        description: 'A task item: true when done, false when not.',
      },
    },
  },
  {
    name: 'Table',
    category: 'data',
    description: 'Rows of cells.',
    placement: 'block',
    content: ['Tr'],
    props: {},
  },
  {
    name: 'Tr',
    category: 'data',
    description: 'A table row.',
    placement: ['Table'],
    content: ['Th', 'Td'],
    props: {},
  },
  {
    name: 'Th',
    category: 'data',
    description: 'A header cell.',
    placement: ['Tr'],
    content: 'inline',
    props: { align: align(['start', 'center', 'end']) },
  },
  {
    name: 'Td',
    category: 'data',
    description: 'A cell.',
    placement: ['Tr'],
    content: 'inline',
    props: { align: align(['start', 'center', 'end']) },
  },
  {
    name: 'Quote',
    category: 'data',
    description: 'Something someone said, such as a review comment.',
    placement: 'block',
    content: 'flow',
    props: {
      author: { type: 'text', max: 60, description: 'Who said it.' },
      location: {
        type: 'text',
        max: 100,
        description: 'Where, such as "idle-shutdown.ts:142".',
      },
    },
  },
  {
    name: 'Code',
    category: 'data',
    description: 'Preformatted text, such as a log excerpt or a diff.',
    placement: 'block',
    content: 'raw',
    props: {
      language: {
        type: 'enum',
        values: ['text', 'diff'],
        default: 'text',
        description: 'diff colours added and removed lines.',
      },
    },
  },
  {
    name: 'Trend',
    category: 'data',
    description: 'A small bar chart; bars over the threshold are highlighted.',
    placement: 'block',
    content: 'none',
    props: {
      values: {
        type: 'numbers',
        min: 2,
        max: 30,
        required: true,
        description: 'Comma-separated numbers, oldest first.',
      },
      threshold: { type: 'number', description: 'Highlight bars above it.' },
      unit: { type: 'text', max: 8, description: 'Such as "¥" or "ms".' },
      label: { type: 'text', max: 60, description: 'What is charted.' },
    },
  },
  {
    name: 'Callout',
    category: 'data',
    description: 'A highlighted note.',
    placement: 'block',
    content: 'flow',
    props: {
      tone: tone('Callout tone.'),
      title: { type: 'text', max: 100, description: 'Bold first line.' },
    },
  },
  // Inputs
  {
    name: 'Choice',
    category: 'input',
    description: 'A single or multiple choice question.',
    placement: 'block',
    content: ['Option'],
    props: {
      id: { type: 'fieldId', required: true, description: 'Answer key.' },
      label: {
        type: 'text',
        max: 100,
        required: true,
        description: 'The question.',
      },
      description: { type: 'text', max: 300, description: 'Help text.' },
      required: { type: 'bool', description: 'Must be answered.' },
      multiple: { type: 'bool', description: 'Several options may be chosen.' },
      min: {
        type: 'int',
        min: 1,
        max: 50,
        description: 'multiple: fewest options.',
      },
      max: {
        type: 'int',
        min: 1,
        max: 50,
        description: 'multiple: most options.',
      },
    },
    cardOnly: true,
  },
  {
    name: 'Option',
    category: 'input',
    description: 'One option of a Choice; its text is the label.',
    placement: ['Choice'],
    content: 'text',
    props: {
      id: { type: 'optionId', required: true, description: 'Answer value.' },
      note: {
        type: 'text',
        max: 40,
        description: 'Shown beside it, such as "about 1 minute".',
      },
      badge: {
        type: 'text',
        max: 16,
        description: 'A tag, such as "breaking".',
      },
      default: { type: 'bool', description: 'Chosen to begin with.' },
      ...thenStatus,
    },
    maxText: 100,
    cardOnly: true,
  },
  {
    name: 'Buttons',
    category: 'input',
    description:
      'A row of buttons answering one question; clicking one answers it.',
    placement: 'block',
    content: ['Button'],
    props: {
      id: { type: 'fieldId', required: true, description: 'Answer key.' },
      label: { type: 'text', max: 100, description: 'The question.' },
      description: { type: 'text', max: 300, description: 'Help text.' },
    },
    cardOnly: true,
  },
  {
    name: 'Button',
    category: 'input',
    description:
      'With id: an answer inside Buttons. With href: a link anywhere, never an answer.',
    placement: 'block',
    content: 'text',
    props: {
      id: { type: 'optionId', description: 'Answer value (inside Buttons).' },
      href: { type: 'url', description: 'Opens a link instead of answering.' },
      primary: { type: 'bool', description: 'The main action.' },
      destructive: { type: 'bool', description: 'A destructive action.' },
      ...thenStatus,
    },
    maxText: 32,
    cardOnly: true,
  },
  {
    name: 'Input',
    category: 'input',
    description: 'A text answer.',
    placement: 'block',
    content: 'none',
    props: {
      id: { type: 'fieldId', required: true, description: 'Answer key.' },
      label: {
        type: 'text',
        max: 100,
        required: true,
        description: 'The question.',
      },
      description: { type: 'text', max: 300, description: 'Help text.' },
      placeholder: { type: 'text', max: 100, description: 'Hint text.' },
      multiline: { type: 'bool', description: 'Several lines.' },
      'max-length': {
        type: 'int',
        min: 1,
        max: 4000,
        description: 'Longest answer; default 1000.',
      },
      required: { type: 'bool', description: 'Must be answered.' },
    },
    cardOnly: true,
  },
  {
    name: 'Submit',
    category: 'input',
    description:
      'The submit button; its text is the label. Left out, the platform adds one when needed.',
    placement: 'block',
    content: 'text',
    props: {},
    maxText: 32,
    cardOnly: true,
  },
];

export const CONTENT_COMPONENT_MAP: ReadonlyMap<string, ComponentSpec> =
  new Map(CONTENT_COMPONENTS.map((spec) => [spec.name, spec]));

export function componentSpec(type: string): ComponentSpec | undefined {
  return CONTENT_COMPONENT_MAP.get(type);
}

/** Input components that compile into the notification's reply form. */
export const INPUT_COMPONENTS = new Set([
  'Choice',
  'Option',
  'Buttons',
  'Input',
  'Submit',
]);

// ------------------------------------------------------------------ helpers

export function isNode(child: ContentChild): child is ContentNode {
  return typeof child !== 'string';
}

export function nodeChildren(node: ContentNode): ContentChild[] {
  return node.children ?? [];
}

export function propString(
  node: ContentNode,
  name: string,
): string | undefined {
  const value = node.props?.[name];
  return typeof value === 'string' ? value : undefined;
}

export function propNumber(
  node: ContentNode,
  name: string,
): number | undefined {
  const value = node.props?.[name];
  return typeof value === 'number' ? value : undefined;
}

export function propBool(node: ContentNode, name: string): boolean {
  return node.props?.[name] === true;
}

/** Every node depth first, parents before children. */
export function* walkContent(
  node: ContentNode,
  parent: ContentNode | null = null,
): Generator<{ node: ContentNode; parent: ContentNode | null }> {
  yield { node, parent };
  for (const child of nodeChildren(node)) {
    if (isNode(child)) yield* walkContent(child, node);
  }
}

/** Plain text of inline content, marks dropped and breaks as newlines. */
export function inlineText(children: readonly ContentChild[]): string {
  return children
    .map((child) => {
      if (typeof child === 'string') return child;
      if (child.type === 'br') return '\n';
      if (child.type === 'time') return propString(child, 'datetime') ?? '';
      return inlineText(nodeChildren(child));
    })
    .join('');
}

/** Status, flag and icon a card shows in its fixed places. */
export type CardHead = {
  status: { label: string; tone: ContentTone } | null;
  flag: string | null;
  icon: CardIconName | null;
};

function toneOf(value: unknown): ContentTone {
  return (CONTENT_TONES as readonly unknown[]).includes(value)
    ? (value as ContentTone)
    : 'neutral';
}

export function cardHead(content: ContentNode | null | undefined): CardHead {
  if (!content || content.type !== CARD_ROOT) {
    return { status: null, flag: null, icon: null };
  }
  const label = propString(content, 'status');
  const icon = propString(content, 'icon');
  return {
    status: label ? { label, tone: toneOf(content.props?.tone) } : null,
    flag: propString(content, 'flag') ?? null,
    icon: (CARD_ICONS as readonly string[]).includes(icon ?? '')
      ? (icon as CardIconName)
      : null,
  };
}

export function hasInlineInputs(content: ContentNode | null | undefined) {
  if (!content) return false;
  for (const { node } of walkContent(content)) {
    if (INPUT_COMPONENTS.has(node.type)) return true;
    if (node.type === 'Button' && propString(node, 'id')) return true;
  }
  return false;
}

/**
 * The name a notification goes by wherever its content is not shown (push,
 * delivery log, recalled line, version history, Agent chat title): the title
 * of a text notification, the summary of the others.
 */
export function notificationHeadline(notification: {
  format?: NotificationFormat | string | null;
  title: string | null;
  summary: string | null;
}): string {
  if (!notification.format || notification.format === 'text') {
    return notification.title ?? notification.summary ?? '';
  }
  return notification.summary ?? notification.title ?? '';
}

/** A summary given for a text notification, or derived from a title. */
export function summaryFromTitle(title: string): string {
  const line = title
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t\f]+/g, ' ')
    .trim();
  const chars = Array.from(line);
  return chars.length > MAX_SUMMARY_LENGTH
    ? `${chars.slice(0, MAX_SUMMARY_LENGTH - 1).join('')}…`
    : line;
}

/**
 * What a card shows in its status area once someone answered an inline
 * question: the chosen option's `then-status` replaces the status and the
 * flag is put away, until the sender next edits the card. Display only.
 */
export function answeredCardHead(args: {
  content: ContentNode | null | undefined;
  answers: Record<string, string | string[]> | null | undefined;
  respondedAt: string | null | undefined;
  editedAt: string | null | undefined;
}): CardHead {
  const head = cardHead(args.content);
  if (!args.content || !args.answers || !args.respondedAt) return head;
  if (
    args.editedAt &&
    Date.parse(args.editedAt) > Date.parse(args.respondedAt)
  ) {
    return head;
  }
  let transition: CardHead['status'] = null;
  for (const { node } of walkContent(args.content)) {
    if (transition) break;
    if (node.type !== 'Choice' && node.type !== 'Buttons') continue;
    const fieldId = propString(node, 'id');
    if (!fieldId || !Object.hasOwn(args.answers, fieldId)) continue;
    const answer = args.answers[fieldId];
    const chosen = Array.isArray(answer) ? answer : [answer];
    for (const option of nodeChildren(node)) {
      if (!isNode(option)) continue;
      const optionId = propString(option, 'id');
      const label = propString(option, 'then-status');
      if (optionId && label && chosen.includes(optionId)) {
        transition = { label, tone: toneOf(option.props?.['then-tone']) };
        break;
      }
    }
  }
  return {
    ...head,
    status: transition ?? head.status,
    flag: null,
  };
}

// ------------------------------------------------------------- inline text

const EDGE_SPACE = /^[ \t\r\n\f]+/;
const END_SPACE = /[ \t\r\n\f]+$/;

/**
 * Tidy inline content the way stored trees keep it: adjacent strings
 * merged, whitespace trimmed at the element's edges (`trimEdges`), around
 * line breaks and next to blocks (`isBlock`), and empty strings dropped.
 */
export function tidyInline(
  children: readonly ContentChild[],
  options: {
    trimEdges: boolean;
    isBlock?: (child: ContentNode) => boolean;
  },
): ContentChild[] {
  const merged: ContentChild[] = [];
  for (const child of children) {
    const last = merged.at(-1);
    if (typeof child === 'string' && typeof last === 'string') {
      merged[merged.length - 1] = last + child;
    } else {
      merged.push(child);
    }
  }
  const breaks = (child: ContentChild | undefined, edge: boolean) =>
    child === undefined
      ? edge
      : typeof child !== 'string' &&
        (child.type === 'br' || (options.isBlock?.(child) ?? false));
  return merged
    .map((child, index) => {
      if (typeof child !== 'string') return child;
      let text = child;
      if (breaks(merged[index - 1], options.trimEdges)) {
        text = text.replace(EDGE_SPACE, '');
      }
      if (breaks(merged[index + 1], options.trimEdges)) {
        text = text.replace(END_SPACE, '');
      }
      return text;
    })
    .filter((child) => child !== '');
}

/**
 * Plain text as inline content: line breaks become `br` nodes and other
 * runs of whitespace one space.
 */
export function textToInline(text: string): ContentChild[] {
  const out: ContentChild[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (index > 0) out.push({ type: 'br' });
    out.push(line.replace(/[ \t\r\f]+/g, ' '));
  });
  return tidyInline(out, { trimEdges: true });
}

/**
 * Raw markup text (Code, Markdown) without the markup's own layout: the line
 * break after the opening tag, a whitespace-only last line before the
 * closing tag, the indentation every line shares and trailing whitespace.
 */
export function dedentRaw(text: string): string {
  const lines = text.replace(/^\r?\n/, '').split(/\r?\n/);
  if (lines.length > 0 && /^[ \t]*$/.test(lines.at(-1)!)) lines.pop();
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines
    .map((line) => line.slice(common))
    .join('\n')
    .replace(/\s+$/, '');
}
