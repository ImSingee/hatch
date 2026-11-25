/**
 * The #319 card shape (`{ status, block }` beside a title and body) and the
 * render tree. Senders that still use it get a card notification whose tree
 * is the title, the body and the block; readers built before the tree get
 * the status and first block of any card. The migration that moved stored
 * cards into trees writes the same tree as `legacyToContent` (its test
 * checks the two agree). Dependency-free.
 */
import {
  CARD_ROOT,
  inlineText,
  isNode,
  nodeChildren,
  propNumber,
  propString,
  textToInline,
  type ContentChild,
  type ContentNode,
  type ContentTone,
} from './notification-content';
import {
  NOTIFICATION_CARD_TONES,
  type NotificationCard,
  type NotificationCardBlock,
  type NotificationCardTone,
} from './notification-card';

/** What a #319 sender wrote: a title, maybe a body, and a card. */
export type LegacyContent = {
  title: string;
  body: string | null;
  card: NotificationCard;
};

function element(
  type: string,
  props: Record<string, string | number> | undefined,
  children: ContentChild[],
): ContentNode {
  const node: ContentNode = { type };
  if (props && Object.keys(props).length > 0) node.props = props;
  if (children.length > 0) node.children = children;
  return node;
}

function blockToContent(
  block: NotificationCardBlock,
  tone: NotificationCardTone | undefined,
): ContentNode {
  switch (block.type) {
    case 'progress':
      return element(
        'Progress',
        {
          label: block.label,
          ...(block.value ? { value: block.value } : {}),
          percent: block.percent,
          // The bar took the status's colour.
          ...(tone && tone !== 'neutral' ? { tone } : {}),
        },
        [],
      );
    case 'stats': {
      const stats = block.items.map((item) =>
        element('Stat', { value: item.value, label: item.label }, []),
      );
      if (stats.length === 1) return stats[0]!;
      return element(
        'Grid',
        stats.length === 2 ? undefined : { columns: stats.length },
        stats,
      );
    }
    case 'quote':
      return element(
        'Quote',
        {
          author: block.author,
          ...(block.location ? { location: block.location } : {}),
        },
        textToInline(block.text),
      );
  }
}

/** The tree a #319 card becomes: title, body, then its block. */
export function legacyToContent(legacy: LegacyContent): ContentNode {
  const { status, block } = legacy.card;
  const children: ContentNode[] = [
    element('Title', undefined, textToInline(legacy.title)),
  ];
  const body = legacy.body ? textToInline(legacy.body) : [];
  if (body.length > 0) children.push(element('Text', undefined, body));
  if (block) children.push(blockToContent(block, status?.tone));
  return element(
    CARD_ROOT,
    status
      ? {
          status: status.label,
          ...(status.tone !== 'neutral' ? { tone: status.tone } : {}),
        }
      : undefined,
    children,
  );
}

const onlyProps = (node: ContentNode, allowed: readonly string[]) =>
  Object.keys(node.props ?? {}).every((name) => allowed.includes(name));

/** Inline content holding nothing but text and line breaks. */
function plainInline(node: ContentNode): string | null {
  const children = nodeChildren(node);
  if (
    !children.every(
      (child) =>
        typeof child === 'string' ||
        (child.type === 'br' && !child.props && !child.children),
    )
  ) {
    return null;
  }
  return inlineText(children);
}

function legacyTone(value: unknown): NotificationCardTone | null {
  return (NOTIFICATION_CARD_TONES as readonly unknown[]).includes(value)
    ? (value as NotificationCardTone)
    : null;
}

function contentToBlock(
  node: ContentNode,
  statusTone: NotificationCardTone | undefined,
): NotificationCardBlock | null {
  switch (node.type) {
    case 'Progress': {
      if (!onlyProps(node, ['label', 'value', 'percent', 'tone'])) return null;
      const label = propString(node, 'label');
      const percent = propNumber(node, 'percent');
      const expectedTone =
        statusTone && statusTone !== 'neutral' ? statusTone : undefined;
      if (!label || percent === undefined) return null;
      if (propString(node, 'tone') !== expectedTone) return null;
      const value = propString(node, 'value');
      return { type: 'progress', label, percent, ...(value ? { value } : {}) };
    }
    case 'Stat':
    case 'Grid': {
      const stats = node.type === 'Stat' ? [node] : nodeChildren(node);
      if (node.type === 'Grid') {
        const columns = propNumber(node, 'columns') ?? 2;
        if (
          !onlyProps(node, ['columns']) ||
          stats.length < 2 ||
          stats.length > 3 ||
          columns !== stats.length
        ) {
          return null;
        }
      }
      const items = [];
      for (const stat of stats) {
        if (
          !isNode(stat) ||
          stat.type !== 'Stat' ||
          stat.children ||
          !onlyProps(stat, ['value', 'label'])
        ) {
          return null;
        }
        const value = propString(stat, 'value');
        const label = propString(stat, 'label');
        if (!value || !label) return null;
        items.push({ value, label });
      }
      return { type: 'stats', items };
    }
    case 'Quote': {
      const author = propString(node, 'author');
      const text = plainInline(node);
      if (!onlyProps(node, ['author', 'location']) || !author || !text) {
        return null;
      }
      const location = propString(node, 'location');
      return { type: 'quote', author, text, ...(location ? { location } : {}) };
    }
    default:
      return null;
  }
}

/**
 * The #319 shape a tree came from, when it is exactly what
 * `legacyToContent` writes; null for any other tree. Edits that still use
 * the old shape merge into it.
 */
export function contentToLegacy(
  content: ContentNode | null | undefined,
): LegacyContent | null {
  if (!content || content.type !== CARD_ROOT) return null;
  if (!onlyProps(content, ['status', 'tone'])) return null;
  const statusLabel = propString(content, 'status');
  const toneProp = content.props?.tone;
  if (toneProp !== undefined && (!statusLabel || !legacyTone(toneProp))) {
    return null;
  }
  const tone = (toneProp as NotificationCardTone | undefined) ?? 'neutral';
  const [title, ...rest] = nodeChildren(content);
  if (!title || !isNode(title) || title.type !== 'Title' || title.props) {
    return null;
  }
  const titleText = plainInline(title);
  if (!titleText) return null;
  let body: string | null = null;
  let next = rest;
  const [maybeText] = rest;
  if (maybeText && isNode(maybeText) && maybeText.type === 'Text') {
    if (maybeText.props) return null;
    body = plainInline(maybeText);
    if (!body) return null;
    next = rest.slice(1);
  }
  if (next.length > 1) return null;
  const [blockNode] = next;
  let block: NotificationCardBlock | undefined;
  if (blockNode) {
    if (!isNode(blockNode)) return null;
    block =
      contentToBlock(blockNode, statusLabel ? tone : undefined) ?? undefined;
    if (!block) return null;
  }
  if (!statusLabel && !block) return null;
  return {
    title: titleText,
    body,
    card: {
      ...(statusLabel ? { status: { label: statusLabel, tone } } : {}),
      ...(block ? { block } : {}),
    },
  };
}

const truncate = (text: string, max: number) => {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
};

/**
 * The #319 card readers built before the tree show: the card's status and
 * its first progress bar, figures or quote, cut to the old limits. Null
 * when the tree has neither.
 */
export function legacyCardPreview(
  content: ContentNode | null | undefined,
): NotificationCard | null {
  if (!content) return null;
  const card: NotificationCard = {};
  const statusLabel = propString(content, 'status');
  if (content.type === CARD_ROOT && statusLabel) {
    const tone = content.props?.tone as ContentTone | undefined;
    card.status = {
      label: truncate(statusLabel, 24),
      // `working` came after #319; those builds show it as neutral anyway.
      tone: legacyTone(tone) ?? 'neutral',
    };
  }
  const find = (node: ContentNode): NotificationCardBlock | null => {
    for (const child of nodeChildren(node)) {
      if (!isNode(child)) continue;
      if (child.type === 'Progress') {
        const percent = propNumber(child, 'percent') ?? 0;
        const value = propString(child, 'value');
        return {
          type: 'progress',
          label: truncate(propString(child, 'label') ?? '', 40),
          percent,
          ...(value ? { value: truncate(value, 24) } : {}),
        };
      }
      if (child.type === 'Stat') {
        const stats = nodeChildren(node)
          .filter(
            (sibling): sibling is ContentNode =>
              isNode(sibling) && sibling.type === 'Stat',
          )
          .slice(0, 3);
        return {
          type: 'stats',
          items: stats.map((stat) => ({
            value: truncate(propString(stat, 'value') ?? '', 24),
            label: truncate(propString(stat, 'label') ?? '', 40),
          })),
        };
      }
      if (child.type === 'Quote') {
        const location = propString(child, 'location');
        return {
          type: 'quote',
          author: truncate(propString(child, 'author') ?? '', 40),
          text: truncate(inlineText(nodeChildren(child)).trim(), 500),
          ...(location ? { location: truncate(location, 80) } : {}),
        };
      }
      const nested = find(child);
      if (nested) return nested;
    }
    return null;
  };
  const block = find(content);
  if (block) card.block = block;
  return card.status || card.block ? card : null;
}
