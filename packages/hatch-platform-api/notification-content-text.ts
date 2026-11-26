/**
 * Two views of a render tree that need no renderer: the plain-text version
 * (webhook and App envelopes, the CLI, anywhere only text fits) and the
 * canonical card markup (read back to edit a card). Dependency-free.
 */
import {
  CARD_ROOT,
  componentSpec,
  dedentRaw,
  isNode,
  nodeChildren,
  propBool,
  propNumber,
  propString,
  type ContentChild,
  type ContentNode,
  type ContentPropValue,
} from './notification-content';

// --------------------------------------------------------------- plain text

const STEP_MARKS: Record<string, string> = {
  done: '✓',
  failed: '✗',
  running: '…',
  pending: '○',
  skipped: '–',
};

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function inlinePlain(children: readonly ContentChild[]): string {
  return children
    .map((child) => {
      if (typeof child === 'string') return child;
      switch (child.type) {
        case 'br':
          return '\n';
        case 'time': {
          const datetime = propString(child, 'datetime');
          return datetime ? formatTime(datetime) : '';
        }
        case 'a': {
          const text = inlinePlain(nodeChildren(child));
          const href = propString(child, 'href') ?? '';
          return !text || text === href ? href : `${text} (${href})`;
        }
        case 'Icon':
          return '';
        default:
          return inlinePlain(nodeChildren(child));
      }
    })
    .join('');
}

function isInline(child: ContentChild): boolean {
  if (typeof child === 'string') return true;
  const placement = componentSpec(child.type)?.placement;
  return placement === 'inline';
}

const indent = (text: string, prefix: string) =>
  text
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n');

/** Flow content: inline runs become lines, blocks keep their own lines. */
function flowPlain(children: readonly ContentChild[]): string[] {
  const lines: string[] = [];
  let run: ContentChild[] = [];
  const flush = () => {
    const text = inlinePlain(run).trim();
    if (text) lines.push(text);
    run = [];
  };
  for (const child of children) {
    if (isInline(child)) {
      run.push(child);
      continue;
    }
    flush();
    const text = blockPlain(child as ContentNode);
    if (text) lines.push(text);
  }
  flush();
  return lines;
}

function blocksPlain(children: readonly ContentChild[]): string {
  return flowPlain(children).join('\n');
}

function blockPlain(node: ContentNode): string {
  const children = nodeChildren(node);
  switch (node.type) {
    case 'Divider':
    case 'Spacer':
    case 'Icon':
    case 'Submit':
      return '';
    case 'Progress': {
      const label = propString(node, 'label');
      const value =
        propString(node, 'value') ?? `${propNumber(node, 'percent') ?? 0}%`;
      return label ? `${label}: ${value}` : value;
    }
    case 'Stat': {
      const delta = propString(node, 'delta');
      return `${propString(node, 'label') ?? ''}: ${propString(node, 'value') ?? ''}${delta ? ` (${delta})` : ''}`;
    }
    case 'Fields':
      return children
        .filter(isNode)
        .map(
          (field) =>
            `${propString(field, 'label') ?? ''}: ${inlinePlain(nodeChildren(field))}`,
        )
        .join('\n');
    case 'Steps':
      return children
        .filter(isNode)
        .map((step) => {
          const mark = STEP_MARKS[propString(step, 'state') ?? 'pending'];
          const at = propString(step, 'at');
          const detail = [
            propString(step, 'detail'),
            at ? formatTime(at) : undefined,
          ]
            .filter(Boolean)
            .join(', ');
          return `${mark} ${inlinePlain(nodeChildren(step))}${detail ? ` (${detail})` : ''}`;
        })
        .join('\n');
    case 'List': {
      const ordered = propBool(node, 'ordered');
      return children
        .filter(isNode)
        .map((item, index) => {
          const checked = item.props?.checked;
          const marker =
            checked === true
              ? '[x]'
              : checked === false
                ? '[ ]'
                : ordered
                  ? `${index + 1}.`
                  : '-';
          const body = blocksPlain(nodeChildren(item));
          const [first = '', ...rest] = body.split('\n');
          return [
            `${marker} ${first}`,
            ...rest.map((line) => (line ? `  ${line}` : line)),
          ].join('\n');
        })
        .join('\n');
    }
    case 'Table':
      return children
        .filter(isNode)
        .map((row) =>
          nodeChildren(row)
            .filter(isNode)
            .map((cell) => inlinePlain(nodeChildren(cell)).trim())
            .join(' | '),
        )
        .join('\n');
    case 'Quote': {
      const author = propString(node, 'author');
      const location = propString(node, 'location');
      const who = [author, location].filter(Boolean).join(' · ');
      const body = indent(blocksPlain(children), '> ');
      return who ? `${who}\n${body}` : body;
    }
    case 'Code':
      return inlinePlain(children);
    case 'Trend': {
      const values = node.props?.values;
      const list = Array.isArray(values) ? values.join(', ') : '';
      const unit = propString(node, 'unit');
      const label = propString(node, 'label');
      const text = unit ? `${list} (${unit})` : list;
      return label ? `${label}: ${text}` : text;
    }
    case 'Callout': {
      const title = propString(node, 'title');
      const body = blocksPlain(children);
      return [title, body].filter(Boolean).join('\n');
    }
    case 'Collapse':
      return [propString(node, 'summary'), blocksPlain(children)]
        .filter(Boolean)
        .join('\n');
    case 'Choice':
      return [
        propString(node, 'label'),
        ...children.filter(isNode).map((option) => {
          const note = propString(option, 'note');
          return `- ${inlinePlain(nodeChildren(option))}${note ? ` (${note})` : ''}`;
        }),
      ]
        .filter(Boolean)
        .join('\n');
    case 'Buttons': {
      const labels = children
        .filter(isNode)
        .map((button) => `[${inlinePlain(nodeChildren(button))}]`)
        .join(' ');
      const label = propString(node, 'label');
      return label ? `${label}\n${labels}` : labels;
    }
    case 'Button': {
      const label = inlinePlain(children);
      const href = propString(node, 'href');
      return href ? `${label}: ${href}` : `[${label}]`;
    }
    case 'Input':
      return propString(node, 'label') ?? '';
    case 'Badge':
      return inlinePlain(children);
    case 'Title':
    case 'Text':
    case 'Caption':
    case 'Th':
    case 'Td':
    case 'Field':
    case 'Step':
      return inlinePlain(children).trim();
    default: {
      const spec = componentSpec(node.type);
      if (spec?.placement === 'inline') return inlinePlain([node]);
      return blocksPlain(children);
    }
  }
}

/**
 * The tree as plain text: one line per paragraph, field, step or row. A
 * card's status (and flag) is the first line.
 */
export function contentToPlainText(content: ContentNode): string {
  const lines: string[] = [];
  if (content.type === CARD_ROOT) {
    const head = [propString(content, 'status'), propString(content, 'flag')]
      .filter(Boolean)
      .join(' · ');
    if (head) lines.push(head);
  }
  const body = blocksPlain(nodeChildren(content));
  if (body) lines.push(body);
  return lines.join('\n');
}

// --------------------------------------------------------- canonical markup

export function escapeMarkupText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeMarkupAttribute(text: string): string {
  return escapeMarkupText(text).replace(/"/g, '&quot;');
}

function attributes(node: ContentNode): string {
  const props = node.props;
  if (!props) return '';
  const spec = componentSpec(node.type);
  // Catalog order, so a stored tree (whose keys Postgres reorders) writes
  // the same markup it was read from; unknown props go last, sorted.
  const known = spec ? Object.keys(spec.props) : [];
  const names = [
    ...known.filter((name) => Object.hasOwn(props, name)),
    ...Object.keys(props)
      .filter((name) => !known.includes(name))
      .sort(),
  ];
  return names
    .map((name) => {
      const value: ContentPropValue = props[name]!;
      if (value === true) return ` ${name}`;
      if (value === false) return ` ${name}="false"`;
      const text = Array.isArray(value) ? value.join(',') : String(value);
      // A value holding double quotes but no single ones reads shorter in
      // single quotes, as a sender may have written it.
      return text.includes('"') && !text.includes("'")
        ? ` ${name}='${escapeMarkupText(text)}'`
        : ` ${name}="${escapeMarkupAttribute(text)}"`;
    })
    .join('');
}

function cdata(text: string): string {
  return `<![CDATA[${text.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

/**
 * Text as markup: escaped, or as CDATA when that is shorter (text full of
 * `&` or `<`), so canonical markup is never much longer than the content.
 */
function textMarkup(text: string): string {
  const escaped = escapeMarkupText(text);
  if (escaped.length === text.length) return escaped;
  const literal = cdata(text);
  return literal.length < escaped.length ? literal : escaped;
}

/**
 * Code or Markdown text as markup. Plain text loses its leading indentation
 * and trailing whitespace when read back (markup layout is dropped), so text
 * where those matter is written as CDATA, which is read exactly.
 */
function rawMarkup(text: string): string {
  return dedentRaw(text) === text ? textMarkup(text) : cdata(text);
}

type Layout = { compact: boolean };

/** Inline content: always on one line, so no layout of its own. */
function inlineMarkup(children: readonly ContentChild[]): string {
  return children
    .map((child) =>
      typeof child === 'string'
        ? textMarkup(child)
        : elementMarkup(child, 0, { compact: true }),
    )
    .join('');
}

function elementMarkup(
  node: ContentNode,
  depth: number,
  layout: Layout,
): string {
  const pad = layout.compact ? '' : '  '.repeat(depth);
  if (node.type === 'Markdown') {
    // Its compiled children are derived; the source is what was written.
    const source = propString(node, 'source') ?? '';
    return `${pad}<Markdown>${rawMarkup(source)}</Markdown>`;
  }
  const open = `<${node.type}${attributes(node)}`;
  const children = nodeChildren(node);
  const spec = componentSpec(node.type);
  if (children.length === 0) return `${pad}${open} />`;
  const content = spec?.content ?? 'blocks';
  if (content === 'raw') {
    const text = children
      .map((child) => (typeof child === 'string' ? child : ''))
      .join('');
    return `${pad}${open}>${rawMarkup(text)}</${node.type}>`;
  }
  if (
    content === 'inline' ||
    content === 'text' ||
    (content === 'flow' && children.every(isInline))
  ) {
    return `${pad}${open}>${inlineMarkup(children)}</${node.type}>`;
  }
  if (layout.compact) {
    return `${open}>${children
      .map((child) =>
        typeof child === 'string'
          ? textMarkup(child)
          : elementMarkup(child, 0, layout),
      )
      .join('')}</${node.type}>`;
  }
  // Blocks (and flow content holding blocks) go one per line; a run of
  // inline content keeps one line of its own.
  const lines: string[] = [];
  let run: ContentChild[] = [];
  const flush = () => {
    if (run.length > 0) lines.push(`${pad}  ${inlineMarkup(run)}`);
    run = [];
  };
  for (const child of children) {
    if (isInline(child)) {
      run.push(child);
      continue;
    }
    flush();
    lines.push(elementMarkup(child as ContentNode, depth + 1, layout));
  }
  flush();
  return `${pad}${open}>\n${lines.join('\n')}\n${pad}</${node.type}>`;
}

/**
 * Canonical markup: two-space indentation, attributes in catalog order,
 * inline content on one line. Parsing it gives the same tree back.
 * `compact` leaves out the layout whitespace; the content size limit is
 * measured on that form, so a card's canonical markup can always be sent
 * back.
 */
export function contentToMarkup(
  content: ContentNode,
  options: { compact?: boolean } = {},
): string {
  return elementMarkup(content, 0, { compact: options.compact ?? false });
}
