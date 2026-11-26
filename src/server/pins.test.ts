import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  listPins,
  pinApp,
  reorderAppPins,
  reorderDashboards,
  setDashboardPinned,
  unpinApp,
  updateAppPin,
} = await import('./pins');
const { subscribePlatformEvents } = await import('./platform-events');

const { readDashboards } = await import('./workspace-read');
const { createDashboard } = await import('./dashboard-service');

const U = 'user-a';
const OTHER = 'user-b';

beforeEach(async () => {
  await db.delete(schema.sidebarItems);
  await db.delete(schema.dashboards);
  await db.delete(schema.apps);
  await db.delete(schema.user);
  for (const id of [U, OTHER])
    await db.insert(schema.user).values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
    });
  await db.insert(schema.apps).values([
    { id: 'app-notes', slug: 'notes', name: 'Notes' },
    { id: 'app-mail', slug: 'mail', name: 'Mail' },
  ]);
});

const ids = async (userId = U) =>
  (await listPins(userId)).appPins.map((pin) => pin.id);

describe('App pins', () => {
  it('adds a pin per call, addressed by id or slug, with its own label and entry point', async () => {
    const first = await pinApp(U, { app: 'notes' });
    expect(first).toMatchObject({
      created: true,
      pin: { appId: 'app-notes', label: 'Notes', entryHash: null },
    });
    const second = await pinApp(U, {
      app: 'app-notes',
      label: '  Inbox ',
      entryHash: '#/inbox',
    });
    expect(second.pin).toMatchObject({ label: 'Inbox', entryHash: '/inbox' });
    expect(await ids()).toEqual([first.pin.id, second.pin.id]);
  });

  it('returns the existing pin for if-absent instead of adding another', async () => {
    const first = await pinApp(U, { app: 'notes', ifAbsent: true });
    expect(first.created).toBe(true);
    const again = await pinApp(U, { app: 'notes', ifAbsent: true });
    expect(again).toMatchObject({ created: false, pin: { id: first.pin.id } });
    expect(await ids()).toEqual([first.pin.id]);
    // The existing pin would silently not receive these.
    await expect(
      pinApp(U, { app: 'notes', ifAbsent: true, label: 'Inbox' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('updates only the fields that are supplied and clears the entry point on null', async () => {
    const { pin } = await pinApp(U, { app: 'notes', entryHash: '/inbox' });
    expect(await updateAppPin(U, pin.id, { label: 'Inbox' })).toMatchObject({
      label: 'Inbox',
      entryHash: '/inbox',
    });
    expect(await updateAppPin(U, pin.id, { entryHash: null })).toMatchObject({
      label: 'Inbox',
      entryHash: null,
    });
    await expect(updateAppPin(U, pin.id, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateAppPin(U, pin.id, { label: ' ' })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    await expect(
      updateAppPin(U, 'missing', { label: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('removes one pin, or every pin of an App', async () => {
    const a = await pinApp(U, { app: 'notes' });
    const b = await pinApp(U, { app: 'notes' });
    const c = await pinApp(U, { app: 'mail' });
    expect(await unpinApp(U, { pinId: a.pin.id })).toEqual([a.pin.id]);
    expect(await ids()).toEqual([b.pin.id, c.pin.id]);
    expect(await unpinApp(U, { app: 'notes' })).toEqual([b.pin.id]);
    // Already unpinned is not an error; an unknown App or pin is.
    expect(await unpinApp(U, { app: 'notes' })).toEqual([]);
    await expect(unpinApp(U, { app: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(unpinApp(U, { pinId: a.pin.id })).rejects.toMatchObject({
      status: 404,
    });
    expect(await ids()).toEqual([c.pin.id]);
  });

  it('reorders listed pins to the front and keeps the rest in order', async () => {
    const a = (await pinApp(U, { app: 'notes' })).pin.id;
    const b = (await pinApp(U, { app: 'mail' })).pin.id;
    const c = (await pinApp(U, { app: 'notes' })).pin.id;
    const d = (await pinApp(U, { app: 'mail' })).pin.id;
    expect((await reorderAppPins(U, [d, b])).map((pin) => pin.id)).toEqual([
      d,
      b,
      a,
      c,
    ]);
    // A later pin still lands at the end.
    const e = (await pinApp(U, { app: 'notes' })).pin.id;
    expect(await ids()).toEqual([d, b, a, c, e]);
    // Rejected reorders change nothing.
    await expect(reorderAppPins(U, [a, a])).rejects.toMatchObject({
      status: 400,
    });
    await expect(reorderAppPins(U, [a, 'missing'])).rejects.toMatchObject({
      status: 404,
    });
    expect(await ids()).toEqual([d, b, a, c, e]);
  });

  it('rejects an entry point longer than storage keeps instead of cutting it', async () => {
    const longest = `/${'x'.repeat(511)}`;
    const { pin } = await pinApp(U, { app: 'notes', entryHash: `#${longest}` });
    expect(pin.entryHash).toBe(longest);
    await expect(
      pinApp(U, { app: 'notes', entryHash: `${longest}y` }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateAppPin(U, pin.id, { entryHash: `${longest}y` }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await listPins(U)).appPins.map((item) => item.entryHash)).toEqual([
      longest,
    ]);
  });

  it('rejects an unknown App', async () => {
    await expect(pinApp(U, { app: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('Dashboard pins', () => {
  it('sets the pinned flag and lists what is pinned', async () => {
    await db.insert(schema.dashboards).values([
      { id: 'd1', name: 'Home', createdAt: new Date('2026-01-01') },
      { id: 'd2', name: 'Ops', createdAt: new Date('2026-01-02') },
    ]);
    await setDashboardPinned(U, 'd1', true);
    expect(await setDashboardPinned(U, 'd2', true)).toEqual({
      id: 'd2',
      pinned: true,
    });
    expect(await reorderDashboards(U, ['d2'])).toEqual(['d2', 'd1']);
    const pins = await listPins(U);
    expect(pins.dashboards).toEqual([
      { id: 'd2', name: 'Ops' },
      { id: 'd1', name: 'Home' },
    ]);
    await expect(setDashboardPinned(U, 'nope', true)).rejects.toMatchObject({
      status: 404,
    });
    await expect(reorderDashboards(U, ['d1', 'd1'])).rejects.toMatchObject({
      status: 400,
    });
    await expect(reorderDashboards(U, ['nope'])).rejects.toMatchObject({
      status: 404,
    });
  });

  it('keeps the order of dashboards a change does not name', async () => {
    await db.insert(schema.dashboards).values([
      { id: 'd1', name: 'One', createdAt: new Date('2026-01-01') },
      { id: 'd2', name: 'Two', createdAt: new Date('2026-01-02') },
      { id: 'd3', name: 'Three', createdAt: new Date('2026-01-03') },
    ]);
    const order = async () => (await readDashboards(U)).map((d) => d.id);
    // Pinning or unpinning leaves a dashboard where it was.
    await setDashboardPinned(U, 'd3', true);
    expect(await order()).toEqual(['d1', 'd2', 'd3']);
    expect(await reorderDashboards(U, ['d3', 'd1'])).toEqual([
      'd3',
      'd1',
      'd2',
    ]);
    await setDashboardPinned(U, 'd3', false);
    expect(await order()).toEqual(['d3', 'd1', 'd2']);
  });
});

describe('Per-user pins', () => {
  it('keeps each user’s App pins, labels and order to that user', async () => {
    const mine = (await pinApp(U, { app: 'notes', label: 'Mine' })).pin;
    const second = (await pinApp(U, { app: 'mail' })).pin;
    expect(await ids(OTHER)).toEqual([]);
    // if-absent only looks at the caller's pins.
    const theirs = await pinApp(OTHER, { app: 'notes', ifAbsent: true });
    expect(theirs.created).toBe(true);
    expect(theirs.pin.label).toBe('Notes');
    await reorderAppPins(U, [second.id]);
    expect(await ids()).toEqual([second.id, mine.id]);
    expect(await ids(OTHER)).toEqual([theirs.pin.id]);

    // Another user's pin is not found, and stays as it was.
    for (const attempt of [
      updateAppPin(OTHER, mine.id, { label: 'Taken' }),
      unpinApp(OTHER, { pinId: mine.id }),
      reorderAppPins(OTHER, [mine.id]),
    ])
      await expect(attempt).rejects.toMatchObject({ status: 404 });
    // Unpinning an App removes only the caller's pins of it.
    expect(await unpinApp(OTHER, { app: 'notes' })).toEqual([theirs.pin.id]);
    expect((await listPins(U)).appPins).toMatchObject([
      { id: second.id },
      { id: mine.id, label: 'Mine' },
    ]);
  });

  it('keeps each user’s dashboard pins and order to that user', async () => {
    await db.insert(schema.dashboards).values([
      { id: 'd1', name: 'Home', createdAt: new Date('2026-01-01') },
      { id: 'd2', name: 'Ops', createdAt: new Date('2026-01-02') },
    ]);
    await setDashboardPinned(U, 'd2', true);
    await reorderDashboards(U, ['d2']);
    expect(await readDashboards(U)).toMatchObject([
      { id: 'd2', pinned: true },
      { id: 'd1', pinned: false },
    ]);
    // Nothing is pinned for a user who never pinned anything; the order is
    // oldest first.
    expect(await readDashboards(OTHER)).toMatchObject([
      { id: 'd1', pinned: false },
      { id: 'd2', pinned: false },
    ]);
    expect((await listPins(OTHER)).dashboards).toEqual([]);
  });

  it('pins a new dashboard for its creator only, at the end of their order', async () => {
    await db
      .insert(schema.dashboards)
      .values([{ id: 'd1', name: 'Home', createdAt: new Date('2026-01-01') }]);
    await setDashboardPinned(OTHER, 'd1', true);
    const created = await createDashboard(U, { name: 'Mine' });
    expect(created).toMatchObject({ name: 'Mine', pinned: true });
    expect(await readDashboards(U)).toMatchObject([
      { id: 'd1', pinned: false },
      { id: created.id, pinned: true },
    ]);
    expect(await readDashboards(OTHER)).toMatchObject([
      { id: 'd1', pinned: true },
      { id: created.id, pinned: false },
    ]);
    // Without a user (a Run nobody prompted) nothing is pinned.
    expect(await createDashboard(null, { name: 'Shared' })).toMatchObject({
      pinned: false,
    });
  });

  it('pins the first dashboard for the user whose visit creates it', async () => {
    expect(await readDashboards(U)).toMatchObject([
      { id: 'default', pinned: true },
    ]);
    expect(await readDashboards(OTHER)).toMatchObject([
      { id: 'default', pinned: false },
    ]);
  });
});

describe('Pin change events', () => {
  it('tells the user’s clients after every change and stays silent otherwise', async () => {
    await db.insert(schema.dashboards).values({ id: 'd1', name: 'Home' });
    const events: unknown[] = [];
    const unsubscribe = subscribePlatformEvents((event) => events.push(event));
    try {
      const { pin } = await pinApp(U, { app: 'notes' });
      await pinApp(U, { app: 'notes', ifAbsent: true });
      await updateAppPin(U, pin.id, { label: 'Journal' });
      await reorderAppPins(U, [pin.id]);
      await setDashboardPinned(U, 'd1', true);
      await reorderDashboards(U, ['d1']);
      await unpinApp(U, { pinId: pin.id });
      await unpinApp(U, { app: 'notes' });
      await expect(unpinApp(U, { pinId: pin.id })).rejects.toThrow(
        'Pin not found.',
      );
    } finally {
      unsubscribe();
    }
    expect(events).toEqual(
      Array.from({ length: 6 }, () => ({ type: 'pins.updated', userId: U })),
    );
  });
});
