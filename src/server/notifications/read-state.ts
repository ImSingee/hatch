/**
 * How far each reader has read the notification timeline.
 *
 * A reader's position is one point in timeline order (`activityAt`, then id).
 * Everything at or before it is read; a notification its source moves past the
 * position by editing it is unread again. The position is shared by all of a
 * user's devices and only moves forward, so a late or repeated request from
 * one device never takes back what another has read. Runs have no user, so
 * the platform Agent keeps one position of its own.
 */
import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '~/db';
import { AppError } from '~server/errors';
import { publishPlatformEvent } from '~server/platform-events';

export type NotificationReader =
  | { type: 'user'; userId: string }
  | { type: 'agent' };

export type NotificationReadState = {
  /** The last notification read; null before the reader read any. */
  readThroughId: string | null;
  /** ISO-8601 activity time of the position. */
  readThroughAt: string;
  /** Notifications after the position, leaving out the reader's own sends. */
  unreadCount: number;
  /** The oldest unread notification in timeline order. */
  firstUnreadId: string | null;
};

export function readerKey(reader: NotificationReader): string {
  return reader.type === 'agent' ? 'agent' : `user:${reader.userId}`;
}

type Cursor = { activityAt: Date; notificationId: string };

async function cursorOf(reader: NotificationReader): Promise<Cursor> {
  const key = readerKey(reader);
  const existing = await db.query.notificationReadCursors.findFirst({
    where: { reader: key },
  });
  if (existing) return existing;
  // A new reader has read everything from before they joined; the Agent
  // starts from its first look.
  let start = new Date();
  if (reader.type === 'user') {
    const user = await db.query.user.findFirst({
      where: { id: reader.userId },
      columns: { createdAt: true },
    });
    if (!user) throw new AppError('User not found.', 404);
    start = user.createdAt;
  }
  await db
    .insert(schema.notificationReadCursors)
    .values({
      reader: key,
      userId: reader.type === 'user' ? reader.userId : null,
      activityAt: start,
    })
    .onConflictDoNothing();
  const created = await db.query.notificationReadCursors.findFirst({
    where: { reader: key },
  });
  return created!;
}

function unreadAfter(reader: NotificationReader, cursor: Cursor): SQL {
  const n = schema.notifications;
  return and(
    sql`(${n.activityAt}, ${n.id}) > (${cursor.activityAt}, ${cursor.notificationId})`,
    // A recalled notification has nothing left to read.
    isNull(n.recalledAt),
    // Nobody needs to read what they sent themselves.
    reader.type === 'user'
      ? sql`not (${n.sourceType} = 'user' and coalesce(${n.userId}, '') = ${reader.userId})`
      : ne(n.sourceType, 'platform'),
  ) as SQL;
}

export async function getReadState(
  reader: NotificationReader,
): Promise<NotificationReadState> {
  const cursor = await cursorOf(reader);
  const n = schema.notifications;
  const condition = unreadAfter(reader, cursor);
  const [[counted], [first]] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(n)
      .where(condition),
    db
      .select({ id: n.id })
      .from(n)
      .where(condition)
      .orderBy(asc(n.activityAt), asc(n.id))
      .limit(1),
  ]);
  return {
    readThroughId: cursor.notificationId || null,
    readThroughAt: cursor.activityAt.toISOString(),
    unreadCount: counted?.count ?? 0,
    firstUnreadId: first?.id ?? null,
  };
}

/**
 * Mark everything up to and including one notification read, or everything
 * so far with `latest`. A position behind the current one changes nothing.
 */
export async function markNotificationsRead(
  reader: NotificationReader,
  through: { notificationId: string } | { latest: true },
): Promise<NotificationReadState> {
  const n = schema.notifications;
  const [target] = await db
    .select({ id: n.id, activityAt: n.activityAt })
    .from(n)
    .where(
      'notificationId' in through
        ? eq(n.id, through.notificationId)
        : undefined,
    )
    .orderBy(desc(n.activityAt), desc(n.id))
    .limit(1);
  if (!target) {
    if ('notificationId' in through) {
      throw new AppError('Notification not found.', 404);
    }
    return getReadState(reader);
  }
  const key = readerKey(reader);
  const c = schema.notificationReadCursors;
  const now = new Date();
  const moved = await db
    .insert(c)
    .values({
      reader: key,
      userId: reader.type === 'user' ? reader.userId : null,
      activityAt: target.activityAt,
      notificationId: target.id,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: c.reader,
      set: {
        activityAt: target.activityAt,
        notificationId: target.id,
        updatedAt: now,
      },
      setWhere: sql`(${c.activityAt}, ${c.notificationId}) < (${target.activityAt}, ${target.id})`,
    })
    .returning({ reader: c.reader });
  if (moved.length > 0) {
    publishPlatformEvent({ type: 'notification.read', reader: key });
  }
  return getReadState(reader);
}
