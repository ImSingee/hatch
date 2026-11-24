/**
 * Timeline read positions: one per user across devices plus one for the
 * platform Agent, moving only forward, and never counting what a reader sent.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { getReadState, markNotificationsRead } = await import('./read-state');

const ada = { type: 'user', userId: 'user-ada' } as const;
const bob = { type: 'user', userId: 'user-bob' } as const;
const agent = { type: 'agent' } as const;

let clock = 0;
async function push(
  id: string,
  source:
    | { sourceType: 'channel' | 'platform' }
    | { sourceType: 'user'; userId: string } = {
    sourceType: 'channel',
  },
) {
  clock += 60_000;
  const at = new Date(clock);
  await db.insert(schema.notifications).values({
    id,
    ...source,
    sourceName: 'Source',
    kind: 'k',
    kindName: 'Kind',
    title: id,
    occurredAt: at,
    createdAt: at,
    activityAt: at,
  });
  return id;
}

beforeEach(async () => {
  // Notifications from the last hour; the users joined before them.
  clock = Date.now() - 3_600_000;
  await db.delete(schema.notifications);
  await db.delete(schema.notificationReadCursors);
  await db.delete(schema.user);
  await db.insert(schema.user).values([
    {
      id: ada.userId,
      name: 'Ada',
      email: 'ada@example.test',
      createdAt: new Date(clock - 3_600_000),
    },
    {
      id: bob.userId,
      name: 'Bob',
      email: 'bob@example.test',
      createdAt: new Date(clock - 3_600_000),
    },
  ]);
});

describe('timeline read positions', () => {
  it('count what arrived since a user joined, except their own sends and recalled ones', async () => {
    const first = await push('n01');
    await push('n02', { sourceType: 'user', userId: ada.userId });
    const recalled = await push('n03');
    await db
      .update(schema.notifications)
      .set({ recalledAt: new Date(clock) })
      .where(eq(schema.notifications.id, recalled));
    await push('n04', { sourceType: 'user', userId: bob.userId });

    expect(await getReadState(ada)).toMatchObject({
      readThroughId: null,
      unreadCount: 2,
      firstUnreadId: first,
    });
    // Bob's own message is not unread for Bob, but Ada's is.
    expect(await getReadState(bob)).toMatchObject({ unreadCount: 2 });
  });

  it('only move forward, per reader, and the Agent keeps its own', async () => {
    const a = await push('n01');
    const b = await push('n02');
    await push('n03', { sourceType: 'platform' });

    const ahead = await markNotificationsRead(ada, { notificationId: b });
    expect(ahead).toMatchObject({ readThroughId: b, unreadCount: 1 });
    // A late request from another device does not take the position back.
    expect(
      await markNotificationsRead(ada, { notificationId: a }),
    ).toMatchObject({ readThroughId: b, unreadCount: 1 });
    expect(await getReadState(bob)).toMatchObject({ unreadCount: 3 });

    // The Agent starts from its first look and never counts platform sends.
    expect(await getReadState(agent)).toMatchObject({ unreadCount: 0 });
    clock = Date.now();
    await push('n04');
    expect(await getReadState(agent)).toMatchObject({ unreadCount: 1 });
    expect(await markNotificationsRead(agent, { latest: true })).toMatchObject({
      readThroughId: 'n04',
      unreadCount: 0,
    });
    expect(await getReadState(ada)).toMatchObject({ unreadCount: 2 });
  });

  it('make a notification unread again when its source moves it past the position', async () => {
    const a = await push('n01');
    await push('n02');
    await markNotificationsRead(ada, { latest: true });
    expect(await getReadState(ada)).toMatchObject({ unreadCount: 0 });

    clock += 60_000;
    await db
      .update(schema.notifications)
      .set({ activityAt: new Date(clock) })
      .where(eq(schema.notifications.id, a));
    expect(await getReadState(ada)).toMatchObject({
      unreadCount: 1,
      firstUnreadId: a,
    });
  });

  it('reject a position at a notification that does not exist', async () => {
    await expect(
      markNotificationsRead(ada, { notificationId: 'missing' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
