import { afterEach, describe, expect, it } from 'vitest';
import type * as Install from '../../../sdk-internal/app/src/storage-install';
import type * as Sdk from '../../../sdk-internal/app/src/storage';

type FrameWindow = Window &
  typeof globalThis & { eval: (code: string) => unknown };

const frames: HTMLIFrameElement[] = [];

/** A same-origin document, like an App page, another tab or a widget frame. */
async function frameWindow(): Promise<FrameWindow> {
  const frame = document.createElement('iframe');
  frames.push(frame);
  const loaded = new Promise((resolve) => {
    frame.addEventListener('load', resolve, { once: true });
  });
  frame.src = '/app/fixture/embed/';
  document.body.append(frame);
  await loaded;
  return frame.contentWindow as FrameWindow;
}

/** Load a module in the frame's own realm, as the App bundle would. */
function load<T>(win: FrameWindow, file: string): Promise<T> {
  return win.eval(`import('/sdk-internal/app/src/${file}')`) as Promise<T>;
}

/** An App page: the platform installs the scope before App code runs. */
async function appPage(appId: string): Promise<FrameWindow> {
  const win = await frameWindow();
  const { installAppStorage } = await load<typeof Install>(
    win,
    'storage-install.ts',
  );
  installAppStorage(appId, win);
  return win;
}

function sdk(win: FrameWindow): Promise<typeof Sdk> {
  return load<typeof Sdk>(win, 'storage.ts');
}

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove();
  localStorage.clear();
  sessionStorage.clear();
});

describe('App browser storage scope', () => {
  it('scopes the standard storage API used by App code and libraries', async () => {
    const raw = await frameWindow();
    raw.localStorage.setItem('mantine-color-scheme-value', 'dark');
    const a = await appPage('app-a');
    const b = await appPage('app-b');

    a.eval("localStorage.setItem('theme', 'dark')");
    a.localStorage.count = '1';
    a.sessionStorage.setItem('tab', 'session only');
    b.localStorage.setItem('theme', 'light');

    // The persisted layout is a data format: changing it loses users' values.
    expect(raw.localStorage.getItem('hatch:app:app-a:theme')).toBe('dark');
    expect(raw.localStorage.getItem('hatch:app:app-a:count')).toBe('1');
    expect(raw.sessionStorage.getItem('hatch:app:app-a:tab')).toBe(
      'session only',
    );
    expect(a.localStorage.getItem('theme')).toBe('dark');
    expect(b.localStorage.getItem('theme')).toBe('light');
    expect(a.localStorage.getItem('mantine-color-scheme-value')).toBeNull();
    expect(a.localStorage).toBeInstanceOf(a.Storage);
    expect(a.localStorage.theme).toBe('dark');
    expect('count' in a.localStorage).toBe(true);
    expect(Object.keys(a.localStorage).sort()).toEqual(['count', 'theme']);
    expect({ ...a.localStorage }).toEqual({ count: '1', theme: 'dark' });
    expect(a.localStorage.length).toBe(2);
    expect([a.localStorage.key(0), a.localStorage.key(1)].sort()).toEqual([
      'count',
      'theme',
    ]);

    delete a.localStorage.count;
    expect(raw.localStorage.getItem('hatch:app:app-a:count')).toBeNull();
    a.localStorage.clear();
    expect(a.localStorage.length).toBe(0);
    expect(b.localStorage.getItem('theme')).toBe('light');
    expect(a.sessionStorage.getItem('tab')).toBe('session only');
    expect(raw.localStorage.getItem('mantine-color-scheme-value')).toBe('dark');
  });

  it("delivers only this App's storage events, with App-relative keys", async () => {
    const raw = await frameWindow();
    const a = await appPage('app-a');
    const otherTabOfA = await appPage('app-a');
    const b = await appPage('app-b');
    const events: unknown[] = [];
    a.addEventListener('storage', (event) =>
      events.push({
        key: event.key,
        newValue: event.newValue,
        ownArea: event.storageArea === a.localStorage,
      }),
    );

    b.localStorage.setItem('theme', 'light');
    otherTabOfA.localStorage.setItem('theme', 'dark');
    await expect.poll(() => events.length).toBe(1);
    raw.localStorage.clear();
    await expect.poll(() => events.length).toBe(2);
    expect(events).toEqual([
      { key: 'theme', newValue: 'dark', ownArea: true },
      { key: null, newValue: null, ownArea: true },
    ]);
  });

  it('lists and watches changes from this page and other documents of the App', async () => {
    const raw = await frameWindow();
    await expect(sdk(raw).then((m) => m.createAppStorage())).rejects.toThrow(
      /served by Hatch/,
    );

    const a = await appPage('app-a');
    const { createAppStorage } = await sdk(a);
    const watcher = createAppStorage();
    const all: Sdk.AppStorageChange[] = [];
    const draft: Sdk.AppStorageChange[] = [];
    const stopAll = watcher.watch((change) => all.push(change));
    const stopDraft = watcher.watch('draft', (change) => draft.push(change));

    // A library writing localStorage directly in the same page is observed.
    a.localStorage.setItem('draft', 'one');
    createAppStorage().setItem('draft', 'one');
    expect(all).toEqual([{ key: 'draft', oldValue: null, newValue: 'one' }]);
    expect(watcher.entries()).toEqual([['draft', 'one']]);

    const otherTabOfA = await appPage('app-a');
    const b = await appPage('app-b');
    otherTabOfA.localStorage.setItem('theme', 'dark');
    b.localStorage.setItem('theme', 'light');
    await expect.poll(() => all.length).toBe(2);
    expect(all[1]).toEqual({ key: 'theme', oldValue: null, newValue: 'dark' });
    expect(watcher.keys().sort()).toEqual(['draft', 'theme']);

    // Another App or Hatch wiping the whole area becomes per-key removals.
    raw.localStorage.clear();
    await expect.poll(() => all.length).toBe(4);
    expect(all.slice(2).sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: 'draft', oldValue: 'one', newValue: null },
      { key: 'theme', oldValue: 'dark', newValue: null },
    ]);
    expect(draft).toEqual([
      { key: 'draft', oldValue: null, newValue: 'one' },
      { key: 'draft', oldValue: 'one', newValue: null },
    ]);

    // A burst from another tab (update, then remove) arrives as queued events
    // after the fact; it is one removal, not two.
    a.localStorage.setItem('burst', 'one');
    const burstStart = all.length;
    otherTabOfA.localStorage.setItem('burst', 'two');
    otherTabOfA.localStorage.removeItem('burst');
    await expect.poll(() => all.length).toBe(burstStart + 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(all.slice(burstStart)).toEqual([
      { key: 'burst', oldValue: 'one', newValue: null },
    ]);

    // A watcher restoring a default while a clear is reported sees the
    // removal and its own restore once, and keeps tracking the restored key.
    const restore = watcher.watch('theme', (change) => {
      if (change.newValue === null) watcher.setItem('theme', 'default');
    });
    a.localStorage.setItem('theme', 'dark');
    for (const previous of ['dark', 'default']) {
      const clearStart = all.length;
      raw.localStorage.clear();
      await expect.poll(() => all.length).toBe(clearStart + 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(all.slice(clearStart)).toEqual([
        { key: 'theme', oldValue: previous, newValue: null },
        { key: 'theme', oldValue: null, newValue: 'default' },
      ]);
      expect(a.localStorage.getItem('theme')).toBe('default');
    }
    restore();

    stopAll();
    stopDraft();
    const stopped = all.length;
    a.localStorage.setItem('theme', 'after');
    expect(all).toHaveLength(stopped);
  });
});
