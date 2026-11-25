/**
 * The versions of one notification as the web and the phone list them,
 * newest first: the one shown now (or when it was recalled), then each one an
 * edit replaced. Pure, so both clients number them, place each round's
 * answer and name what changed the same way.
 */
import {
  cardHead,
  type ContentNode,
  type NotificationFormat,
} from './notification-content';
import type { ReplyForm } from './notification-reply';

/** One version's content, from the notification or a kept revision. */
export type VersionContent = {
  format: NotificationFormat;
  /** Text notifications only. */
  title: string | null;
  body: string | null;
  summary: string | null;
  /** The tree of a Markdown or card version. */
  content: ContentNode | null;
  url: string | null;
  reply: ReplyForm | null;
  replyRound: number;
  data?: unknown;
};

/** What changed from one version to the next, in the order people scan. */
export type VersionChange =
  | 'status'
  | 'format'
  | 'title'
  | 'summary'
  | 'body'
  | 'content'
  | 'link'
  | 'data'
  | 'question'
  | 'questionRemoved';

export type VersionEntry<T extends VersionContent> = T & {
  /** 1 for the original, counting up to the one shown now. */
  number: number;
  current: boolean;
  /** The last version of its round: the one that shows the round's answer. */
  lastOfRound: boolean;
  /**
   * What differs from the version before it; empty for the original, and for
   * the oldest loaded version while older ones are not loaded yet.
   */
  changes: VersionChange[];
};

/** Equal JSON whatever the key order (stored trees come back reordered). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((v, i) => same(v, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && same(left[key], right[key]),
    )
  );
}

/** A tree without the status and flag the card shows in its fixed place. */
function body(content: ContentNode | null): unknown {
  if (!content) return null;
  const {
    status: _status,
    tone: _tone,
    flag: _flag,
    ...props
  } = content.props ?? {};
  return { ...content, props };
}

export function versionChanges(
  newer: VersionContent,
  older: VersionContent,
  options: { compareData: boolean },
): VersionChange[] {
  const changes: VersionChange[] = [];
  const newerHead = cardHead(newer.content);
  const olderHead = cardHead(older.content);
  if (
    !same(newerHead.status, olderHead.status) ||
    newerHead.flag !== olderHead.flag
  ) {
    changes.push('status');
  }
  if (newer.format !== older.format) changes.push('format');
  if ((newer.title ?? null) !== (older.title ?? null)) changes.push('title');
  if ((newer.summary ?? null) !== (older.summary ?? null)) {
    changes.push('summary');
  }
  if (newer.body !== older.body) changes.push('body');
  if (!same(body(newer.content), body(older.content))) changes.push('content');
  if (newer.url !== older.url) changes.push('link');
  if (options.compareData && !same(newer.data, older.data)) {
    changes.push('data');
  }
  if (newer.replyRound !== older.replyRound) {
    changes.push(newer.reply ? 'question' : 'questionRemoved');
  }
  return changes;
}

/**
 * `earlier` is newest first and may be only the first pages; `total` is how
 * many versions there are in all (earlier versions + 1).
 */
export function buildVersionList<T extends VersionContent>(
  current: T,
  earlier: T[],
  options: { total: number; compareData?: boolean },
): VersionEntry<T>[] {
  const all = [current, ...earlier];
  const compareData = options.compareData ?? false;
  return all.map((version, index) => {
    const number = options.total - index;
    const older = all[index + 1];
    const newer = all[index - 1];
    return {
      ...version,
      number,
      current: index === 0,
      lastOfRound: !newer || newer.replyRound !== version.replyRound,
      changes: older ? versionChanges(version, older, { compareData }) : [],
    };
  });
}
