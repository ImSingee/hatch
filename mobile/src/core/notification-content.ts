/**
 * Reads a notification's render tree from its `content_json` without zod
 * (the phone bundles none). The platform validated the tree when it was sent;
 * this only makes sure that whatever arrives, from this instance or a newer
 * one, is shaped so the renderer can walk it without throwing. Anything that
 * is not is dropped, and a tree that cannot be read at all is null, so the
 * screen falls back to the plain text.
 */
import type {
  ContentChild,
  ContentNode,
  ContentPropValue,
  NotificationFormat,
} from '../../../packages/hatch-platform-api/notification-content';

/** Far deeper than the platform allows; it only bounds recursion. */
const MAX_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propValue(value: unknown): ContentPropValue | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const numbers = value.filter(
      (item): item is number =>
        typeof item === 'number' && Number.isFinite(item),
    );
    return numbers.length === value.length ? numbers : undefined;
  }
  return undefined;
}

function readNode(value: unknown, depth: number): ContentNode | null {
  if (!isRecord(value) || typeof value.type !== 'string' || !value.type) {
    return null;
  }
  const node: ContentNode = { type: value.type };
  if (isRecord(value.props)) {
    const props: Record<string, ContentPropValue> = {};
    for (const [name, raw] of Object.entries(value.props)) {
      const prop = propValue(raw);
      if (prop !== undefined) props[name] = prop;
    }
    node.props = props;
  }
  if (Array.isArray(value.children) && depth < MAX_DEPTH) {
    const children: ContentChild[] = [];
    for (const child of value.children) {
      if (typeof child === 'string') {
        if (child) children.push(child);
        continue;
      }
      const read = readNode(child, depth + 1);
      if (read) children.push(read);
    }
    node.children = children;
  }
  return node;
}

/** The tree in `content_json`, or null when it is absent or unreadable. */
export function contentFromJson(json: string | undefined): ContentNode | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return readNode(parsed, 0);
}

/** A notification's format: markdown, card, or else text. */
export function knownFormat(value: string): NotificationFormat {
  return value === 'markdown' || value === 'card' ? value : 'text';
}
