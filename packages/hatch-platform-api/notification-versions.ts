/**
 * The versions of one notification as the web and the phone list them,
 * newest first: the one shown now (or when it was recalled), then each one an
 * edit replaced. Pure, so both clients number them, place each round's
 * answer and name what changed the same way.
 */
import type { NotificationCard } from './notification-card';
import type { ReplyForm } from './notification-reply';

/** One version's content, from the notification or a kept revision. */
export type VersionContent = {
  title: string;
  body: string | null;
  url: string | null;
  card: NotificationCard | null;
  reply: ReplyForm | null;
  replyRound: number;
  data?: unknown;
};

/** What changed from one version to the next, in the order people scan. */
export type VersionChange =
  | 'status'
  | 'title'
  | 'body'
  | 'link'
  | 'card'
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

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function versionChanges(
  newer: VersionContent,
  older: VersionContent,
  options: { compareData: boolean },
): VersionChange[] {
  const changes: VersionChange[] = [];
  if (!same(newer.card?.status, older.card?.status)) changes.push('status');
  if (newer.title !== older.title) changes.push('title');
  if (newer.body !== older.body) changes.push('body');
  if (newer.url !== older.url) changes.push('link');
  if (!same(newer.card?.block, older.card?.block)) changes.push('card');
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
