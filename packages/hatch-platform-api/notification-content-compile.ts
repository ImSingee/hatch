/**
 * Compiling notification content without dependencies: card markup, a JSON
 * tree (its shape already checked) and Markdown blocks all end as one
 * normalized render tree, held to the component catalog and the limits, and
 * a card's inline inputs as its reply form. The platform and the CLI reach
 * it through `notification-content-schema` (which adds the zod shape checks
 * and the remark Markdown parser); anything that runs without them, such as
 * a native App, calls it directly with a Markdown step of its own.
 *
 * Errors name the line and column (markup) or the path (JSON tree) and list
 * what is allowed there.
 */
import {
  MAX_MARKUP_DEPTH,
  parseMarkup,
  MarkupSyntaxError,
  type MarkupElement,
  type MarkupText,
} from './notification-card-markup';
import {
  CARD_ROOT,
  CONTENT_COMPONENTS,
  DOCUMENT_ROOT,
  MAX_CARD_SOURCE_BYTES,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_DEPTH,
  MAX_CONTENT_NODES,
  MAX_TEXT_LENGTH,
  componentSpec,
  inlineText,
  isNode,
  nodeChildren,
  propBool,
  propNumber,
  propString,
  dedentRaw,
  tidyInline,
  walkContent,
  type ComponentSpec,
  type ContentChild,
  type ContentNode,
  type ContentPropValue,
  type PropSpec,
} from './notification-content';
import { contentToMarkup } from './notification-content-text';
import {
  REPLY_FIELD_ID_RE,
  REPLY_OPTION_ID_RE,
  type ReplyForm,
} from './notification-reply';
import {
  normalizeReplyForm,
  type ReplyFieldInput,
} from './notification-reply-form';
import { isNotificationUrl } from './notification-url';

/**
 * Markdown source to the blocks it reads as (`Title`, `Text`, `List`, ...),
 * before they are held to the catalog.
 */
export type MarkdownToBlocks = (source: string) => ContentNode[];

export type CompileOptions = {
  /** Compiles Markdown: a `<Markdown>` element's text, or a document. */
  markdownToBlocks: MarkdownToBlocks;
};

// ------------------------------------------------------------------ errors

export type ContentIssue = {
  message: string;
  /** Markup position. */
  line?: number;
  column?: number;
  /** JSON tree path, such as `children.2.props.tone`. */
  path?: string;
};

export function formatContentIssue(issue: ContentIssue): string {
  if (issue.line !== undefined) {
    return `${issue.line}:${issue.column}: ${issue.message}`;
  }
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/** Content that cannot be used; `issues` lists up to 20 problems. */
export class ContentError extends Error {
  readonly issues: ContentIssue[];

  constructor(issues: ContentIssue[]) {
    super(issues.map(formatContentIssue).join('\n'));
    this.name = 'ContentError';
    this.issues = issues;
  }
}

/** Problems reported for one piece of content, at most. */
export const MAX_CONTENT_ISSUES = 20;

// ------------------------------------------------------------------- input

type Where = { line: number; column: number } | { path: string };

type InputText = { kind: 'text'; text: string; where: Where; raw: boolean };
type InputNode = {
  kind: 'node';
  type: string;
  props: { name: string; value: unknown; where: Where }[];
  children: InputChild[];
  where: Where;
  /** From markup: text keeps source formatting to undo. */
  markup: boolean;
};
type InputChild = InputNode | InputText;

const at = (where: Where): Partial<ContentIssue> =>
  'path' in where
    ? { path: where.path }
    : { line: where.line, column: where.column };

function fromMarkup(element: MarkupElement): InputNode {
  return {
    kind: 'node',
    type: element.name,
    props: element.attributes.map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
      where: { line: attribute.line, column: attribute.column },
    })),
    children: element.children.map((child) =>
      child.kind === 'element'
        ? fromMarkup(child)
        : textFromMarkup(child as MarkupText),
    ),
    where: { line: element.line, column: element.column },
    markup: true,
  };
}

function textFromMarkup(text: MarkupText): InputText {
  return {
    kind: 'text',
    text: text.text,
    where: { line: text.line, column: text.column },
    raw: text.cdata,
  };
}

/** A tree as senders give it, its shape already checked. */
export type JsonNode = {
  type: string;
  props?: Record<string, unknown> | null;
  children?: (string | JsonNode)[] | null;
};

/**
 * Whether the element children of a tree node at `depth` are read. A tree
 * is read down to the first nodes nested past `MAX_CONTENT_DEPTH`, which the
 * walk reports, with their text but no elements: however deep it nests,
 * reading it cannot exhaust the stack.
 */
const readsBelow = (depth: number) => depth <= MAX_CONTENT_DEPTH;

function fromJson(node: JsonNode, path: string, depth: number): InputNode {
  const prefix = path ? `${path}.` : '';
  const children: InputChild[] = [];
  for (const [index, child] of (node.children ?? []).entries()) {
    const where = { path: `${prefix}children.${index}` };
    if (typeof child === 'string') {
      children.push({ kind: 'text', text: child, where, raw: true });
    } else if (readsBelow(depth)) {
      children.push(fromJson(child, where.path, depth + 1));
    }
  }
  return {
    kind: 'node',
    type: node.type,
    props: Object.entries(node.props ?? {}).map(([name, value]) => ({
      name,
      value,
      where: { path: `${prefix}props.${name}` },
    })),
    children,
    where: { path: path || 'card' },
    markup: false,
  };
}

/**
 * The problem with a JSON tree, its shape not yet checked, that nests more
 * than `MAX_MARKUP_DEPTH` levels (as deep as the markup parser reads): its
 * depth, at the first node of that chain past `MAX_CONTENT_DEPTH`, where the
 * walk would report it. Null for any other tree. It reads at most that deep,
 * so it can run before shape checks that read a tree recursively; trees it
 * lets through are shallow enough for them to report every problem.
 */
export function cardTreeTooDeep(tree: unknown): ContentIssue | null {
  const childrenOf = (node: unknown): unknown[] => {
    const children =
      typeof node === 'object' && node !== null
        ? (node as { children?: unknown }).children
        : undefined;
    return Array.isArray(children) ? children : [];
  };
  const nestsPast = (node: unknown, depth: number): boolean =>
    depth > MAX_MARKUP_DEPTH ||
    childrenOf(node).some(
      (child) =>
        typeof child === 'object' &&
        child !== null &&
        nestsPast(child, depth + 1),
    );
  const find = (node: unknown, depth: number, path: string): string | null => {
    if (depth > MAX_CONTENT_DEPTH) return nestsPast(node, depth) ? path : null;
    const prefix = path ? `${path}.` : '';
    for (const [index, child] of childrenOf(node).entries()) {
      if (typeof child !== 'object' || child === null) continue;
      const found = find(child, depth + 1, `${prefix}children.${index}`);
      if (found !== null) return found;
    }
    return null;
  };
  const path = find(tree, 0, '');
  return path === null ? null : { message: tooDeepMessage, path };
}

// -------------------------------------------------------------- prop values

const COLLAPSE = /[ \t\r\n\f]+/g;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
/** What senders read when a value is none of the forms a prop takes. */
const INVALID = 'Invalid input';

const length = (text: string) => Array.from(text).length;

type Coerced = { value: ContentPropValue } | { error: string };

/** Decimal text as a number; text too long to be finite is rejected. */
function decimal(text: string): { number: number } | { error: string } {
  const number = Number(text);
  return Number.isFinite(number)
    ? { number }
    : { error: `Invalid input: expected number, received ${number}` };
}

/** A number: a finite number, or its decimal text. */
function toNumber(value: unknown): { number: number } | { error: string } {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { number: value } : { error: INVALID };
  }
  if (typeof value !== 'string') return { error: INVALID };
  const text = value.trim();
  return NUMBER_RE.test(text) ? decimal(text) : { error: INVALID };
}

/** The type of a value as the messages name it. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return typeof value;
}

/** A prop value as given (markup text, or any JSON value) to its stored form. */
function coerceProp(spec: PropSpec, value: unknown): Coerced {
  switch (spec.type) {
    case 'text': {
      if (typeof value !== 'string') return { error: 'must be text' };
      const text = value.replace(COLLAPSE, ' ').trim();
      return length(text) <= spec.max
        ? { value: text }
        : { error: `must be at most ${spec.max} characters` };
    }
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? { value }
        : { error: `must be one of ${spec.values.join(', ')}` };
    case 'bool':
      if (typeof value === 'boolean') return { value };
      if (value === 'true' || value === 'false') {
        return { value: value === 'true' };
      }
      return { error: INVALID };
    case 'int': {
      const parsed = toNumber(value);
      if ('error' in parsed) return parsed;
      const { number } = parsed;
      // Whole numbers JavaScript holds exactly.
      if (!Number.isSafeInteger(number))
        return { error: 'must be a whole number' };
      return number < spec.min || number > spec.max
        ? { error: `must be ${spec.min}-${spec.max}` }
        : { value: number };
    }
    case 'number': {
      const parsed = toNumber(value);
      if ('error' in parsed) return parsed;
      const { number } = parsed;
      if (spec.min !== undefined && number < spec.min) {
        return { error: `must be at least ${spec.min}` };
      }
      if (spec.max !== undefined && number > spec.max) {
        return { error: `must be at most ${spec.max}` };
      }
      return { value: number };
    }
    case 'numbers': {
      let numbers: number[];
      if (Array.isArray(value)) {
        // A copy, checked slot by slot: `every` would skip the holes of a
        // sparse array.
        numbers = [];
        for (let index = 0; index < value.length; index++) {
          const item: unknown = value[index];
          if (typeof item !== 'number' || !Number.isFinite(item)) {
            return { error: INVALID };
          }
          numbers.push(item);
        }
      } else if (typeof value === 'string') {
        const parts = value.split(',').map((part) => part.trim());
        if (parts.some((part) => !NUMBER_RE.test(part))) {
          return { error: INVALID };
        }
        numbers = parts.map(Number);
      } else {
        return { error: INVALID };
      }
      // Too many is reported first, then decimal text too long for a
      // finite number, then too few.
      const count = { error: `must list ${spec.min}-${spec.max} numbers` };
      if (numbers.length > spec.max) return count;
      const infinite = numbers.find((number) => !Number.isFinite(number));
      if (infinite !== undefined) {
        return {
          error: `Invalid input: expected number, received ${infinite}`,
        };
      }
      return numbers.length < spec.min ? count : { value: numbers };
    }
    case 'url': {
      if (typeof value !== 'string') return { error: 'must be a link' };
      const url = value.trim();
      if (url.length > 2048) {
        return { error: 'must be at most 2048 characters' };
      }
      return isNotificationUrl(url)
        ? { value: url }
        : {
            error:
              'must be an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link',
          };
    }
    case 'datetime': {
      if (typeof value !== 'string') {
        return { error: 'must be an ISO-8601 time' };
      }
      const time = value.trim();
      return DATETIME_RE.test(time) && !Number.isNaN(Date.parse(time))
        ? { value: time }
        : {
            error: 'must be an ISO-8601 time such as 2026-11-25T02:14:00Z',
          };
    }
    case 'fieldId':
      if (typeof value !== 'string') {
        return {
          error: `Invalid input: expected string, received ${typeName(value)}`,
        };
      }
      return REPLY_FIELD_ID_RE.test(value)
        ? { value }
        : {
            error:
              'must start with a lowercase letter and use at most 40 lowercase letters, digits or "_"',
          };
    case 'optionId':
      if (typeof value !== 'string') {
        return {
          error: `Invalid input: expected string, received ${typeName(value)}`,
        };
      }
      return REPLY_OPTION_ID_RE.test(value)
        ? { value }
        : { error: 'must be 1-40 lowercase letters, digits, "_", "-" or "."' };
  }
}

// ---------------------------------------------------------------- the walk

type Mode = 'card' | 'document';

type State = {
  mode: Mode;
  issues: ContentIssue[];
  nodes: number;
  tooDeep: boolean;
  tooMany: boolean;
  /** Where each output node came from, for later errors. */
  origins: Map<ContentNode, Where>;
  /** Compiles the source of a `<Markdown>` element. */
  markdownToBlocks: MarkdownToBlocks;
};

const tag = (type: string) => `<${type}>`;

const tooDeepMessage = `content is nested more than ${MAX_CONTENT_DEPTH} levels deep`;

function fits(child: ComponentSpec, parent: ComponentSpec): boolean {
  if (Array.isArray(parent.content)) return parent.content.includes(child.name);
  if (Array.isArray(child.placement) || child.placement === 'root') {
    return false;
  }
  switch (parent.content) {
    case 'blocks':
      return child.placement === 'block' || child.placement === 'both';
    case 'inline':
      return child.placement === 'inline' || child.placement === 'both';
    case 'flow':
      return true;
    default:
      return false;
  }
}

function allowedInside(parent: ComponentSpec, mode: Mode): string {
  if (
    parent.content === 'text' ||
    parent.content === 'raw' ||
    parent.content === 'none'
  ) {
    return parent.content === 'none'
      ? `${tag(parent.name)} takes no content`
      : `${tag(parent.name)} takes text only`;
  }
  const names = CONTENT_COMPONENTS.filter(
    (spec) => fits(spec, parent) && (mode === 'card' || !spec.cardOnly),
  ).map((spec) => spec.name);
  return `allowed inside ${tag(parent.name)}: ${names.join(', ')}`;
}

function isBlockNode(node: ContentNode): boolean {
  const placement = componentSpec(node.type)?.placement;
  return placement !== 'inline';
}

/**
 * The text of a Code or Markdown element. Markup text is written inside
 * indented markup, so its indentation is dropped; text in CDATA is kept
 * exactly as written (the canonical markup uses it for text whose spacing
 * matters), with whitespace-only markup text around it ignored. A JSON tree's
 * text is already exact.
 */
function rawText(input: InputNode): string {
  const texts = input.children.filter(
    (child): child is InputText => child.kind === 'text',
  );
  if (!input.markup) return texts.map((child) => child.text).join('');
  if (texts.some((child) => child.raw)) {
    return texts
      .filter((child) => child.raw || /[^ \t\r\n\f]/.test(child.text))
      .map((child) => child.text)
      .join('');
  }
  return dedentRaw(texts.map((child) => child.text).join(''));
}

/**
 * Children with each run of adjacent text (split by CDATA in markup, or
 * given as several strings) joined into one, so whitespace is collapsed
 * across the run as it would be in one piece of text.
 */
function mergeText(children: readonly InputChild[]): InputChild[] {
  const out: InputChild[] = [];
  for (const child of children) {
    const last = out.at(-1);
    if (child.kind === 'text' && last?.kind === 'text') {
      out[out.length - 1] = { ...last, text: last.text + child.text };
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Text as inline content, by where it came from. */
function inlineFromText(text: InputText, markup: boolean): ContentChild[] {
  if (markup) return [text.text.replace(COLLAPSE, ' ')];
  const out: ContentChild[] = [];
  text.text.split(/\r?\n/).forEach((line, index) => {
    if (index > 0) out.push({ type: 'br' });
    out.push(line.replace(/[ \t\r\f]+/g, ' '));
  });
  return out;
}

function walk(
  input: InputNode,
  parent: ComponentSpec | null,
  depth: number,
  state: State,
): ContentNode | null {
  const issue = (message: string, where: Where = input.where) => {
    if (state.issues.length < MAX_CONTENT_ISSUES) {
      state.issues.push({ message, ...at(where) });
    }
  };
  const spec = componentSpec(input.type);
  if (!spec || (state.mode === 'document' && spec.cardOnly)) {
    issue(
      `${tag(input.type)} is not a component; ${
        parent
          ? allowedInside(parent, state.mode)
          : `a card starts with ${tag(CARD_ROOT)}`
      }`,
    );
    return null;
  }
  if (parent ? !fits(spec, parent) : spec.name !== CARD_ROOT) {
    issue(
      parent
        ? `${tag(spec.name)} cannot go inside ${tag(parent.name)}; ${allowedInside(parent, state.mode)}`
        : `a card starts with ${tag(CARD_ROOT)}, not ${tag(spec.name)}`,
    );
    return null;
  }
  if (depth > MAX_CONTENT_DEPTH && !state.tooDeep) {
    state.tooDeep = true;
    issue(tooDeepMessage);
  }
  state.nodes += 1;
  if (state.nodes > MAX_CONTENT_NODES && !state.tooMany) {
    state.tooMany = true;
    issue(`content has more than ${MAX_CONTENT_NODES} elements`);
  }

  // Props
  const props: Record<string, ContentPropValue> = {};
  const invalid = new Set<string>();
  for (const prop of input.props) {
    // A stored tree keeps a Markdown element's source as a prop (handled
    // below); markup writes it as the element's text.
    if (spec.name === 'Markdown' && prop.name === 'source' && !input.markup) {
      continue;
    }
    const propSpec = Object.hasOwn(spec.props, prop.name)
      ? spec.props[prop.name]
      : undefined;
    if (!propSpec) {
      const names = Object.keys(spec.props);
      issue(
        `${tag(spec.name)} has no "${prop.name}" attribute; ${
          names.length > 0 ? `allowed: ${names.join(', ')}` : 'it takes none'
        }`,
        prop.where,
      );
      continue;
    }
    if (prop.value === null || prop.value === undefined || prop.value === '') {
      continue;
    }
    const parsed = coerceProp(propSpec, prop.value);
    if ('error' in parsed) {
      // Reported once: an invalid value is not also missing.
      invalid.add(prop.name);
      issue(`${tag(spec.name)} ${prop.name} ${parsed.error}`, prop.where);
      continue;
    }
    const value = parsed.value;
    // Left out, and so missing if required: text that was only whitespace,
    // like an empty value, and `false`.
    if (
      value === '' ||
      (value === false && !(propSpec.type === 'bool' && propSpec.keepFalse))
    ) {
      continue;
    }
    if ('default' in propSpec && propSpec.default === value) continue;
    props[prop.name] = value;
  }
  for (const [name, propSpec] of Object.entries(spec.props)) {
    if (
      propSpec.required &&
      !Object.hasOwn(props, name) &&
      !invalid.has(name)
    ) {
      issue(`${tag(spec.name)} needs ${name}`);
    }
  }

  // Children
  const node: ContentNode = { type: spec.name };
  // Catalog order, so equal content builds equal trees.
  const ordered = Object.fromEntries(
    Object.keys(spec.props)
      .filter((name) => Object.hasOwn(props, name))
      .map((name) => [name, props[name]!]),
  );
  if (Object.keys(ordered).length > 0) node.props = ordered;
  state.origins.set(node, input.where);
  const content = spec.content;
  const kids: ContentChild[] = [];
  const textOnly = content === 'text' || content === 'raw';

  if (spec.name === 'Markdown') {
    // A tree read back from storage carries the source and its compiled
    // children; the children are compiled again from the source.
    const stored = input.markup
      ? undefined
      : input.props.find((prop) => prop.name === 'source')?.value;
    if (stored !== undefined && typeof stored !== 'string') {
      issue(`${tag('Markdown')} source must be text`);
    }
    const source = typeof stored === 'string' ? stored : rawText(input);
    if (
      stored === undefined &&
      input.children.some((child) => child.kind === 'node')
    ) {
      issue(`${tag('Markdown')} takes Markdown text, not elements`);
    }
    node.props = { source };
    const compiled = state.markdownToBlocks(source);
    const documentSpec = componentSpec(DOCUMENT_ROOT)!;
    const nested: State = { ...state, mode: 'document' };
    for (const block of compiled) {
      const walked = walk(
        fromJsonTree(block, input.where, depth + 1),
        documentSpec,
        depth + 1,
        nested,
      );
      if (walked) kids.push(walked);
    }
    state.nodes = nested.nodes;
    state.tooDeep = nested.tooDeep;
    state.tooMany = nested.tooMany;
    if (kids.length > 0) node.children = kids;
    return node;
  }

  const inline = content === 'inline' || content === 'flow';
  for (const child of inline ? mergeText(input.children) : input.children) {
    if (child.kind === 'text') {
      if (content === 'raw') continue; // read whole by rawText below
      if (textOnly) {
        kids.push(child.text.replace(COLLAPSE, ' '));
        continue;
      }
      const isWhitespace = !/[^ \t\r\n\f]/.test(child.text);
      if (inline) {
        kids.push(...inlineFromText(child, input.markup));
        continue;
      }
      if (!isWhitespace) {
        issue(
          content === 'none'
            ? `${tag(spec.name)} takes no content`
            : `text cannot go directly inside ${tag(spec.name)}; ${
                Array.isArray(content)
                  ? allowedInside(spec, state.mode)
                  : `wrap it in ${tag('Text')}`
              }`,
          child.where,
        );
      }
      continue;
    }
    if (textOnly || content === 'none') {
      issue(
        `${tag(child.type)} cannot go inside ${tag(spec.name)}; ${allowedInside(spec, state.mode)}`,
        child.where,
      );
      continue;
    }
    const walked = walk(child, spec, depth + 1, state);
    if (walked) kids.push(walked);
  }

  let children: ContentChild[];
  if (content === 'raw') {
    const value = rawText(input);
    children = value ? [value] : [];
  } else if (content === 'text') {
    const value = (kids as string[]).join('').replace(COLLAPSE, ' ').trim();
    children = value ? [value] : [];
  } else if (content === 'inline' || content === 'flow') {
    children = tidyInline(kids, {
      trimEdges: spec.placement !== 'inline',
      isBlock: content === 'flow' ? isBlockNode : undefined,
    });
  } else {
    children = kids;
  }
  if (children.length > 0) node.children = children;

  const max = spec.maxText ?? MAX_TEXT_LENGTH;
  if (
    content !== 'blocks' &&
    !Array.isArray(content) &&
    length(inlineText(children)) > max
  ) {
    issue(`${tag(spec.name)} text must be at most ${max} characters`);
  }
  if (
    (spec.name === 'Option' ||
      spec.name === 'Button' ||
      spec.name === 'Submit') &&
    children.length === 0
  ) {
    issue(`${tag(spec.name)} needs a label as its text`);
  }
  if (spec.name === 'Button') {
    const inButtons = parent?.name === 'Buttons';
    if (inButtons) {
      if (props.href !== undefined || !props.id) {
        issue(
          `${tag('Button')} inside ${tag('Buttons')} needs an id and no href; put link buttons outside ${tag('Buttons')}`,
        );
      }
    } else if (
      props.id !== undefined ||
      !props.href ||
      props.primary !== undefined ||
      props.destructive !== undefined ||
      props['then-status'] !== undefined
    ) {
      issue(
        `${tag('Button')} outside ${tag('Buttons')} is a link: give it href only; answer buttons go inside ${tag('Buttons')}`,
      );
    }
  }
  return node;
}

/**
 * A tree node already built (Markdown output) at `depth` as walk input, read
 * as far as `fromJson` reads a tree.
 */
function fromJsonTree(
  node: ContentNode,
  where: Where,
  depth: number,
): InputNode {
  const children: InputChild[] = [];
  for (const child of node.children ?? []) {
    if (typeof child === 'string') {
      children.push({ kind: 'text', text: child, where, raw: true });
    } else if (readsBelow(depth)) {
      children.push(fromJsonTree(child, where, depth + 1));
    }
  }
  return {
    kind: 'node',
    type: node.type,
    props: Object.entries(node.props ?? {}).map(([name, value]) => ({
      name,
      value,
      where,
    })),
    children,
    where,
    markup: false,
  };
}

// ------------------------------------------------------------- inline form

type FieldOrigin = { node: ContentNode; options: ContentNode[] };

/**
 * The reply form a card's inline inputs make, in document order: `Choice`
 * becomes a single or multiple field, `Buttons` a buttons field (always
 * required), `Input` a text field and `Submit` the submit label.
 */
function compileInlineForm(
  content: ContentNode,
  state: State,
): ReplyForm | null {
  const fields: ReplyFieldInput[] = [];
  const origins: FieldOrigin[] = [];
  const submits: ContentNode[] = [];
  const report = (node: ContentNode, message: string) => {
    if (state.issues.length < MAX_CONTENT_ISSUES) {
      state.issues.push({ message, ...at(state.origins.get(node)!) });
    }
  };
  for (const { node } of walkContent(content)) {
    const text = (child: ContentNode) => inlineText(nodeChildren(child));
    const options = nodeChildren(node).filter(isNode);
    switch (node.type) {
      case 'Choice': {
        const multiple = propBool(node, 'multiple');
        const defaults = options
          .filter((option) => propBool(option, 'default'))
          .map((option) => propString(option, 'id')!);
        fields.push({
          id: propString(node, 'id')!,
          type: multiple ? 'multiple' : 'single',
          label: propString(node, 'label'),
          description: propString(node, 'description'),
          required: propBool(node, 'required'),
          options: options.map((option) => ({
            id: propString(option, 'id')!,
            label: text(option),
            note: propString(option, 'note'),
            badge: propString(option, 'badge'),
          })),
          minSelected: multiple ? propNumber(node, 'min') : undefined,
          maxSelected: multiple ? propNumber(node, 'max') : undefined,
          default: multiple
            ? defaults.length > 0
              ? defaults
              : undefined
            : defaults.length > 1
              ? defaults
              : defaults[0],
        });
        if (!multiple && (propNumber(node, 'min') ?? propNumber(node, 'max'))) {
          report(node, `${tag('Choice')} min and max need multiple`);
        }
        origins.push({ node, options });
        break;
      }
      case 'Buttons':
        fields.push({
          id: propString(node, 'id')!,
          type: 'buttons',
          label: propString(node, 'label'),
          description: propString(node, 'description'),
          required: true,
          options: options.map((option) => ({
            id: propString(option, 'id')!,
            label: text(option),
            primary: propBool(option, 'primary') || undefined,
            destructive: propBool(option, 'destructive') || undefined,
          })),
        });
        origins.push({ node, options });
        break;
      case 'Input':
        fields.push({
          id: propString(node, 'id')!,
          type: 'text',
          label: propString(node, 'label'),
          description: propString(node, 'description'),
          required: propBool(node, 'required'),
          placeholder: propString(node, 'placeholder'),
          multiline: propBool(node, 'multiline'),
          maxLength: propNumber(node, 'max-length'),
        });
        origins.push({ node, options: [] });
        break;
      case 'Submit':
        submits.push(node);
        break;
    }
  }
  if (submits.length > 1) {
    report(submits[1]!, `a card has at most one ${tag('Submit')}`);
  }
  if (fields.length === 0) {
    if (submits[0]) {
      report(
        submits[0],
        `${tag('Submit')} needs a ${tag('Choice')}, ${tag('Buttons')} or ${tag('Input')} to submit`,
      );
    }
    return null;
  }
  const { form, issues } = normalizeReplyForm({
    fields,
    submitLabel: submits[0] ? inlineText(nodeChildren(submits[0])) : undefined,
  });
  if (issues.length === 0) return form;
  for (const problem of issues) {
    const [first, index, key, optionIndex] = problem.path;
    const origin =
      first === 'fields' && typeof index === 'number' ? origins[index] : null;
    const target =
      origin && key === 'options' && typeof optionIndex === 'number'
        ? (origin.options[optionIndex] ?? origin.node)
        : (origin?.node ?? content);
    report(target, `${tag(target.type)} ${problem.message}`);
  }
  return null;
}

// --------------------------------------------------------------- compiling

export type CompiledCard = {
  content: ContentNode;
  /** The reply form its inline inputs make; null without inputs. */
  reply: ReplyForm | null;
};

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function newState(mode: Mode, options: CompileOptions): State {
  return {
    mode,
    issues: [],
    nodes: 0,
    tooDeep: false,
    tooMany: false,
    origins: new Map(),
    markdownToBlocks: options.markdownToBlocks,
  };
}

function finishCard(root: InputNode, options: CompileOptions): CompiledCard {
  const state = newState('card', options);
  const content = walk(root, null, 0, state);
  if (!content || state.issues.length > 0) {
    throw new ContentError(
      state.issues.length > 0 ? state.issues : [{ message: 'invalid card' }],
    );
  }
  const reply = compileInlineForm(content, state);
  if (state.issues.length > 0) throw new ContentError(state.issues);
  // Measured on the compact canonical form, so a card is judged by its
  // content however it was written, and its canonical markup (the compact
  // form plus layout whitespace) always fits the source limit when sent back.
  const size = byteLength(contentToMarkup(content, { compact: true }));
  if (size > MAX_CONTENT_BYTES) {
    throw new ContentError([
      {
        message: `the card must be at most ${MAX_CONTENT_BYTES / 1024} KiB as compact markup; it is ${Math.ceil(size / 1024)} KiB`,
      },
    ]);
  }
  return { content, reply };
}

/** The error for a source over `MAX_CARD_SOURCE_BYTES`. */
export function cardSourceTooLarge(what: string): ContentError {
  return new ContentError([
    { message: `${what} must be at most ${MAX_CARD_SOURCE_BYTES / 1024} KiB` },
  ]);
}

/** Card markup to its tree and inline form; throws `ContentError`. */
export function compileCardMarkupWith(
  markup: string,
  options: CompileOptions,
): CompiledCard {
  if (byteLength(markup) > MAX_CARD_SOURCE_BYTES) {
    throw cardSourceTooLarge('card markup');
  }
  let element: MarkupElement;
  try {
    element = parseMarkup(markup);
  } catch (error) {
    if (error instanceof MarkupSyntaxError) {
      throw new ContentError([
        {
          message: error.message.replace(/^\d+:\d+: /, ''),
          line: error.line,
          column: error.column,
        },
      ]);
    }
    throw error;
  }
  return finishCard(fromMarkup(element), options);
}

/**
 * A card given as a JSON tree whose shape (`type`, `props`, `children`) was
 * checked; throws `ContentError`.
 */
export function compileCardJsonWith(
  tree: JsonNode,
  options: CompileOptions,
): CompiledCard {
  return finishCard(fromJson(tree, '', 0), options);
}

/** Markdown source to its tree; throws `ContentError`. */
export function compileMarkdownWith(
  source: string,
  options: CompileOptions,
): ContentNode {
  if (byteLength(source) > MAX_CONTENT_BYTES) {
    throw new ContentError([
      { message: `markdown must be at most ${MAX_CONTENT_BYTES / 1024} KiB` },
    ]);
  }
  if (source.trim() === '') {
    throw new ContentError([{ message: 'markdown must not be empty' }]);
  }
  const state = newState('document', options);
  // The root counts against the element limit, as a card's does.
  state.nodes = 1;
  const documentSpec = componentSpec(DOCUMENT_ROOT)!;
  const root: ContentNode = { type: DOCUMENT_ROOT };
  const children: ContentNode[] = [];
  for (const [index, block] of options.markdownToBlocks(source).entries()) {
    const walked = walk(
      fromJsonTree(block, { path: `markdown block ${index + 1}` }, 1),
      documentSpec,
      1,
      state,
    );
    if (walked) children.push(walked);
  }
  if (state.issues.length > 0) throw new ContentError(state.issues);
  if (children.length > 0) root.children = children;
  return root;
}
