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

beforeEach(async () => {
  await db.delete(schema.sidebarItems);
  await db.delete(schema.dashboards);
  await db.delete(schema.apps);
  await db.insert(schema.apps).values([
    { id: 'app-notes', slug: 'notes', name: 'Notes' },
    { id: 'app-mail', slug: 'mail', name: 'Mail' },
  ]);
});

const ids = async () => (await listPins()).appPins.map((pin) => pin.id);

describe('App pins', () => {
  it('adds a pin per call, addressed by id or slug, with its own label and entry point', async () => {
    const first = await pinApp({ app: 'notes' });
    expect(first).toMatchObject({
      created: true,
      pin: { appId: 'app-notes', label: 'Notes', entryHash: null },
    });
    const second = await pinApp({
      app: 'app-notes',
      label: '  Inbox ',
      entryHash: '#/inbox',
    });
    expect(second.pin).toMatchObject({ label: 'Inbox', entryHash: '/inbox' });
    expect(await ids()).toEqual([first.pin.id, second.pin.id]);
  });

  it('returns the existing pin for if-absent instead of adding another', async () => {
    const first = await pinApp({ app: 'notes', ifAbsent: true });
    expect(first.created).toBe(true);
    const again = await pinApp({ app: 'notes', ifAbsent: true });
    expect(again).toMatchObject({ created: false, pin: { id: first.pin.id } });
    expect(await ids()).toEqual([first.pin.id]);
    // The existing pin would silently not receive these.
    await expect(
      pinApp({ app: 'notes', ifAbsent: true, label: 'Inbox' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('updates only the fields that are supplied and clears the entry point on null', async () => {
    const { pin } = await pinApp({ app: 'notes', entryHash: '/inbox' });
    expect(await updateAppPin(pin.id, { label: 'Inbox' })).toMatchObject({
      label: 'Inbox',
      entryHash: '/inbox',
    });
    expect(await updateAppPin(pin.id, { entryHash: null })).toMatchObject({
      label: 'Inbox',
      entryHash: null,
    });
    await expect(updateAppPin(pin.id, {})).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateAppPin(pin.id, { label: ' ' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(updateAppPin('missing', { label: 'X' })).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it('removes one pin, or every pin of an App', async () => {
    const a = await pinApp({ app: 'notes' });
    const b = await pinApp({ app: 'notes' });
    const c = await pinApp({ app: 'mail' });
    expect(await unpinApp({ pinId: a.pin.id })).toEqual([a.pin.id]);
    expect(await ids()).toEqual([b.pin.id, c.pin.id]);
    expect(await unpinApp({ app: 'notes' })).toEqual([b.pin.id]);
    // Already unpinned is not an error; an unknown App or pin is.
    expect(await unpinApp({ app: 'notes' })).toEqual([]);
    await expect(unpinApp({ app: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(unpinApp({ pinId: a.pin.id })).rejects.toMatchObject({
      status: 404,
    });
    expect(await ids()).toEqual([c.pin.id]);
  });

  it('reorders listed pins to the front and keeps the rest in order', async () => {
    const a = (await pinApp({ app: 'notes' })).pin.id;
    const b = (await pinApp({ app: 'mail' })).pin.id;
    const c = (await pinApp({ app: 'notes' })).pin.id;
    const d = (await pinApp({ app: 'mail' })).pin.id;
    expect((await reorderAppPins([d, b])).map((pin) => pin.id)).toEqual([
      d,
      b,
      a,
      c,
    ]);
    // A later pin still lands at the end.
    const e = (await pinApp({ app: 'notes' })).pin.id;
    expect(await ids()).toEqual([d, b, a, c, e]);
    // Rejected reorders change nothing.
    await expect(reorderAppPins([a, a])).rejects.toMatchObject({ status: 400 });
    await expect(reorderAppPins([a, 'missing'])).rejects.toMatchObject({
      status: 404,
    });
    expect(await ids()).toEqual([d, b, a, c, e]);
  });

  it('rejects an entry point longer than storage keeps instead of cutting it', async () => {
    const longest = `/${'x'.repeat(511)}`;
    const { pin } = await pinApp({ app: 'notes', entryHash: `#${longest}` });
    expect(pin.entryHash).toBe(longest);
    await expect(
      pinApp({ app: 'notes', entryHash: `${longest}y` }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateAppPin(pin.id, { entryHash: `${longest}y` }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await listPins()).appPins.map((item) => item.entryHash)).toEqual([
      longest,
    ]);
  });

  it('rejects an unknown App', async () => {
    await expect(pinApp({ app: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('Dashboard pins', () => {
  it('sets the pinned flag and lists what is pinned', async () => {
    await db.insert(schema.dashboards).values([
      { id: 'd1', name: 'Home', pinned: true, sortOrder: 0 },
      { id: 'd2', name: 'Ops', pinned: false, sortOrder: 1 },
    ]);
    expect(await setDashboardPinned('d2', true)).toEqual({
      id: 'd2',
      pinned: true,
    });
    expect(await reorderDashboards(['d2'])).toEqual(['d2', 'd1']);
    const pins = await listPins();
    expect(pins.dashboards).toEqual([
      { id: 'd2', name: 'Ops' },
      { id: 'd1', name: 'Home' },
    ]);
    await expect(setDashboardPinned('nope', true)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('Pin change events', () => {
  it('tells connected clients after every change and stays silent otherwise', async () => {
    await db.insert(schema.dashboards).values({ id: 'd1', name: 'Home' });
    const events: string[] = [];
    const unsubscribe = subscribePlatformEvents((event) =>
      events.push(event.type),
    );
    try {
      const { pin } = await pinApp({ app: 'notes' });
      await pinApp({ app: 'notes', ifAbsent: true });
      await updateAppPin(pin.id, { label: 'Journal' });
      await reorderAppPins([pin.id]);
      await setDashboardPinned('d1', true);
      await unpinApp({ pinId: pin.id });
      await unpinApp({ app: 'notes' });
      await expect(unpinApp({ pinId: pin.id })).rejects.toThrow(
        'Pin not found.',
      );
    } finally {
      unsubscribe();
    }
    expect(events).toEqual(Array.from({ length: 5 }, () => 'pins.updated'));
  });
});
