/**
 * Validation and compilation of notification content, shared by the
 * platform (every sender) and the CLI (offline checks before any request),
 * so both reject the same input with the same messages.
 *
 * Card markup, a JSON tree and Markdown all end as one normalized render
 * tree, held to the component catalog and the limits. Errors name the line
 * and column (markup) or the path (JSON tree) and list what is allowed
 * there. Inline inputs of a card compile into the notification's reply form.
 */
import { z } from 'zod';
import {
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
  MAX_SUMMARY_LENGTH,
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
import { markdownToBlocks } from './notification-markdown';
import {
  REPLY_FIELD_ID_RE,
  REPLY_OPTION_ID_RE,
  type ReplyForm,
} from './notification-reply';
import { notificationReplySchema } from './notification-reply-schema';
import { isNotificationUrl } from './notification-url';

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

const MAX_ISSUES = 20;

// ------------------------------------------------------------------ summary

/**
 * A summary: one line of plain text, at most 200 characters. Empty
 * spellings mean none.
 */
export const summarySchema = z
  .string({ error: 'summary must be a string' })
  .trim()
  .min(1, 'summary must not be empty')
  .refine((value) => !/[\r\n]/.test(value), {
    message: 'summary must be one line, without line breaks',
  })
  .refine((value) => Array.from(value).length <= MAX_SUMMARY_LENGTH, {
    message: `summary must be at most ${MAX_SUMMARY_LENGTH} characters`,
  });

export const optionalSummarySchema = z.preprocess(
  // Blank text is an empty spelling too: it would leave a Markdown or card
  // notification without anything to show where its content is not shown.
  (value) =>
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
      ? null
      : value,
  summarySchema.nullable(),
);

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

type JsonNode = {
  type: string;
  props?: Record<string, unknown> | null;
  children?: (string | JsonNode)[] | null;
};

const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z
    .object(
      {
        type: z
          .string({ error: 'type must be a component name' })
          .min(1, 'type must be a component name'),
        props: z
          .record(z.string(), z.unknown(), {
            error: 'props must be an object',
          })
          .nullish(),
        children: z
          .array(z.union([z.string(), jsonNodeSchema]), {
            error: 'children must be a list of nodes and strings',
          })
          .nullish(),
      },
      { error: 'a node must be an object with a type' },
    )
    .strict(),
);

function fromJson(node: JsonNode, path: string): InputNode {
  const prefix = path ? `${path}.` : '';
  return {
    kind: 'node',
    type: node.type,
    props: Object.entries(node.props ?? {}).map(([name, value]) => ({
      name,
      value,
      where: { path: `${prefix}props.${name}` },
    })),
    children: (node.children ?? []).map((child, index) =>
      typeof child === 'string'
        ? {
            kind: 'text' as const,
            text: child,
            where: { path: `${prefix}children.${index}` },
            raw: true,
          }
        : fromJson(child, `${prefix}children.${index}`),
    ),
    where: { path: path || 'card' },
    markup: false,
  };
}

// -------------------------------------------------------------- prop values

const COLLAPSE = /[ \t\r\n\f]+/g;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

const length = (text: string) => Array.from(text).length;

const fromFlag = z.union([
  z.literal(true),
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

const fromNumber = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(NUMBER_RE, 'must be a number')
    .transform((value) => Number(value)),
]);

function propSchema(spec: PropSpec): z.ZodType<ContentPropValue> {
  switch (spec.type) {
    case 'text':
      return z
        .string({ error: 'must be text' })
        .transform((value) => value.replace(COLLAPSE, ' ').trim())
        .refine((value) => length(value) <= spec.max, {
          message: `must be at most ${spec.max} characters`,
        });
    case 'enum':
      return z.enum(spec.values as [string, ...string[]], {
        error: `must be one of ${spec.values.join(', ')}`,
      });
    case 'bool':
      return fromFlag.pipe(z.boolean({ error: 'must be true or false' }));
    case 'int':
      return fromNumber.pipe(
        z
          .number()
          .int({ error: 'must be a whole number' })
          .min(spec.min, { error: `must be ${spec.min}-${spec.max}` })
          .max(spec.max, { error: `must be ${spec.min}-${spec.max}` }),
      );
    case 'number': {
      let number = z.number().finite({ error: 'must be a number' });
      if (spec.min !== undefined) {
        number = number.min(spec.min, {
          error: `must be at least ${spec.min}`,
        });
      }
      if (spec.max !== undefined) {
        number = number.max(spec.max, { error: `must be at most ${spec.max}` });
      }
      return fromNumber.pipe(number);
    }
    case 'numbers':
      return z
        .union([
          z.array(z.number()),
          z.string().transform((value, ctx) => {
            const parts = value.split(',').map((part) => part.trim());
            if (parts.some((part) => !NUMBER_RE.test(part))) {
              ctx.addIssue({
                code: 'custom',
                message: 'must be numbers separated by commas',
              });
              return z.NEVER;
            }
            return parts.map(Number);
          }),
        ])
        .pipe(
          z
            .array(z.number().finite())
            .min(spec.min, {
              error: `must list ${spec.min}-${spec.max} numbers`,
            })
            .max(spec.max, {
              error: `must list ${spec.min}-${spec.max} numbers`,
            }),
        );
    case 'url':
      return z
        .string({ error: 'must be a link' })
        .trim()
        .max(2048, 'must be at most 2048 characters')
        .refine(isNotificationUrl, {
          message:
            'must be an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link',
        });
    case 'datetime':
      return z
        .string({ error: 'must be an ISO-8601 time' })
        .trim()
        .refine(
          (value) =>
            DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value)),
          { message: 'must be an ISO-8601 time such as 2026-11-25T02:14:00Z' },
        );
    case 'fieldId':
      return z
        .string()
        .regex(
          REPLY_FIELD_ID_RE,
          'must start with a lowercase letter and use at most 40 lowercase letters, digits or "_"',
        );
    case 'optionId':
      return z
        .string()
        .regex(
          REPLY_OPTION_ID_RE,
          'must be 1-40 lowercase letters, digits, "_", "-" or "."',
        );
  }
}

const propSchemas = new Map<PropSpec, z.ZodType<ContentPropValue>>();
function schemaFor(spec: PropSpec) {
  let schema = propSchemas.get(spec);
  if (!schema) {
    schema = propSchema(spec);
    propSchemas.set(spec, schema);
  }
  return schema;
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
};

const tag = (type: string) => `<${type}>`;

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
    if (state.issues.length < MAX_ISSUES) {
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
  if (parent ? !fits(spec, parent) : spec.placement !== 'root') {
    issue(
      parent
        ? `${tag(spec.name)} cannot go inside ${tag(parent.name)}; ${allowedInside(parent, state.mode)}`
        : `a card starts with ${tag(CARD_ROOT)}, not ${tag(spec.name)}`,
    );
    return null;
  }
  if (depth > MAX_CONTENT_DEPTH && !state.tooDeep) {
    state.tooDeep = true;
    issue(`content is nested more than ${MAX_CONTENT_DEPTH} levels deep`);
  }
  state.nodes += 1;
  if (state.nodes > MAX_CONTENT_NODES && !state.tooMany) {
    state.tooMany = true;
    issue(`content has more than ${MAX_CONTENT_NODES} elements`);
  }

  // Props
  const props: Record<string, ContentPropValue> = {};
  const given = new Set<string>();
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
    // Reported once: an invalid value is not also missing.
    given.add(prop.name);
    const parsed = schemaFor(propSpec).safeParse(prop.value);
    if (!parsed.success) {
      issue(
        `${tag(spec.name)} ${prop.name} ${parsed.error.issues[0]?.message ?? 'is invalid'}`,
        prop.where,
      );
      continue;
    }
    const value = parsed.data;
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
    if (propSpec.required && !Object.hasOwn(props, name) && !given.has(name)) {
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
    const compiled = markdownToBlocks(source);
    const documentSpec = componentSpec(DOCUMENT_ROOT)!;
    const nested: State = { ...state, mode: 'document' };
    for (const block of compiled) {
      const walked = walk(
        fromJsonTree(block, input.where),
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

  for (const child of input.children) {
    if (child.kind === 'text') {
      if (content === 'raw') continue; // read whole by rawText below
      if (textOnly) {
        kids.push(child.text.replace(COLLAPSE, ' '));
        continue;
      }
      const isWhitespace = !/[^ \t\r\n\f]/.test(child.text);
      if (content === 'inline' || content === 'flow') {
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

/** A tree node already built (Markdown output) as walk input. */
function fromJsonTree(node: ContentNode, where: Where): InputNode {
  return {
    kind: 'node',
    type: node.type,
    props: Object.entries(node.props ?? {}).map(([name, value]) => ({
      name,
      value,
      where,
    })),
    children: (node.children ?? []).map((child) =>
      typeof child === 'string'
        ? { kind: 'text' as const, text: child, where, raw: true }
        : fromJsonTree(child, where),
    ),
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
  const fields: Record<string, unknown>[] = [];
  const origins: FieldOrigin[] = [];
  const submits: ContentNode[] = [];
  for (const { node } of walkContent(content)) {
    const text = (child: ContentNode) => inlineText(nodeChildren(child));
    const options = nodeChildren(node).filter(isNode);
    switch (node.type) {
      case 'Choice': {
        const multiple = propBool(node, 'multiple');
        const defaults = options
          .filter((option) => propBool(option, 'default'))
          .map((option) => propString(option, 'id'));
        fields.push({
          id: propString(node, 'id'),
          type: multiple ? 'multiple' : 'single',
          label: propString(node, 'label'),
          description: propString(node, 'description'),
          required: propBool(node, 'required'),
          options: options.map((option) => ({
            id: propString(option, 'id'),
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
          state.issues.push({
            message: `${tag('Choice')} min and max need multiple`,
            ...at(state.origins.get(node)!),
          });
        }
        origins.push({ node, options });
        break;
      }
      case 'Buttons':
        fields.push({
          id: propString(node, 'id'),
          type: 'buttons',
          label: propString(node, 'label'),
          description: propString(node, 'description'),
          required: true,
          options: options.map((option) => ({
            id: propString(option, 'id'),
            label: text(option),
            primary: propBool(option, 'primary') || undefined,
            destructive: propBool(option, 'destructive') || undefined,
          })),
        });
        origins.push({ node, options });
        break;
      case 'Input':
        fields.push({
          id: propString(node, 'id'),
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
  const report = (node: ContentNode, message: string) => {
    if (state.issues.length < MAX_ISSUES) {
      state.issues.push({ message, ...at(state.origins.get(node)!) });
    }
  };
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
  const parsed = notificationReplySchema.safeParse({
    fields,
    submitLabel: submits[0] ? inlineText(nodeChildren(submits[0])) : undefined,
  });
  if (parsed.success) return parsed.data;
  for (const problem of parsed.error.issues) {
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

function finishCard(root: InputNode): CompiledCard {
  const state: State = {
    mode: 'card',
    issues: [],
    nodes: 0,
    tooDeep: false,
    tooMany: false,
    origins: new Map(),
  };
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

function tooLarge(what: string): ContentError {
  return new ContentError([
    { message: `${what} must be at most ${MAX_CARD_SOURCE_BYTES / 1024} KiB` },
  ]);
}

/** Card markup to its tree and inline form; throws `ContentError`. */
export function compileCardMarkup(markup: string): CompiledCard {
  if (byteLength(markup) > MAX_CARD_SOURCE_BYTES) {
    throw tooLarge('card markup');
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
  return finishCard(fromMarkup(element));
}

/** A card given as a JSON tree; throws `ContentError`. */
export function compileCardTree(tree: unknown): CompiledCard {
  if (byteLength(JSON.stringify(tree) ?? '') > MAX_CARD_SOURCE_BYTES) {
    throw tooLarge('the card tree');
  }
  const parsed = jsonNodeSchema.safeParse(tree);
  if (!parsed.success) {
    throw new ContentError(
      parsed.error.issues.slice(0, MAX_ISSUES).map((problem) => ({
        message: problem.message,
        path: problem.path.join('.') || 'card',
      })),
    );
  }
  return finishCard(fromJson(parsed.data, ''));
}

/**
 * A card as senders give it: markup, or a JSON tree (an object with a
 * `type`). A JSON string holding a tree is read as the tree.
 */
export function compileCard(input: unknown): CompiledCard {
  if (typeof input === 'string') {
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
      return compileCardTree(tree);
    }
    return compileCardMarkup(input);
  }
  return compileCardTree(input);
}

/** Markdown source to its tree; throws `ContentError`. */
export function compileMarkdown(source: string): ContentNode {
  if (byteLength(source) > MAX_CONTENT_BYTES) {
    throw new ContentError([
      { message: `markdown must be at most ${MAX_CONTENT_BYTES / 1024} KiB` },
    ]);
  }
  if (source.trim() === '') {
    throw new ContentError([{ message: 'markdown must not be empty' }]);
  }
  const state: State = {
    mode: 'document',
    issues: [],
    nodes: 0,
    tooDeep: false,
    tooMany: false,
    origins: new Map(),
  };
  const documentSpec = componentSpec(DOCUMENT_ROOT)!;
  const root: ContentNode = { type: DOCUMENT_ROOT };
  const children: ContentNode[] = [];
  for (const [index, block] of markdownToBlocks(source).entries()) {
    const walked = walk(
      fromJsonTree(block, { path: `markdown block ${index + 1}` }),
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

/**
 * Whether a `card` value is the #319 shape (`{ status, block }`) rather
 * than markup or a tree.
 */
export function isLegacyCardInput(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, 'type')
  );
}
