import { expect, test } from 'vitest';
import { AppSessionStore } from './app-sessions';

const store = (limit = 12) => new AppSessionStore({ limit, storage: null });
const slugs = (s: AppSessionStore) =>
  s.getSnapshot().sessions.map((session) => session.slug);

test('a slug that names an Object property opens at its own route', () => {
  const sessions = store();

  expect(sessions.show('constructor', { route: '', focus: true })).toBeNull();
  expect(sessions.session('constructor')?.route).toBe('');
});

test('a renamed running App is found by its id, not started twice', () => {
  const sessions = store();
  sessions.show('notes', { route: '/draft', focus: false, appId: 'app-1' });
  const started = sessions.session('notes')!;
  sessions.leaveFront('notes');

  const mirrored = sessions.show('journal', {
    route: '',
    focus: true,
    appId: 'app-1',
  });

  expect(slugs(sessions)).toEqual(['journal']);
  const renamed = sessions.session('journal')!;
  // The same running frame, still loaded from the old slug.
  expect(renamed.key).toBe(started.key);
  expect(renamed.frameSlug).toBe('notes');
  expect(mirrored).toBe('/draft');
  expect(sessions.getSnapshot().front).toBe('journal');
});

test('an App kept beside but hidden is stopped by recency like any other', () => {
  const sessions = store(3);
  const keyOf = (slug: string) => sessions.session(slug)!.key;
  sessions.show('a', { route: '', focus: false });
  sessions.openBeside('b', { appId: 'b', revision: null });
  sessions.setVisible([keyOf('a'), keyOf('b')]);
  // The window narrows: only the App in front shows.
  sessions.setVisible([keyOf('a')]);
  sessions.leaveFront('a');
  sessions.show('c', { route: '', focus: false });
  sessions.setVisible([keyOf('c')]);

  sessions.show('d', { route: '', focus: false });

  expect(slugs(sessions)).toEqual(['a', 'c', 'd']);
  expect(sessions.getSnapshot().beside).toBeNull();
});

test('a slug taken over by another App does not show the old App', () => {
  const sessions = store();
  sessions.show('notes', { route: '/old', focus: false, appId: 'app-1' });
  const first = sessions.session('notes')!;
  sessions.leaveFront('notes');

  // app-1 was renamed elsewhere and app-2 now uses `notes`.
  sessions.show('notes', { route: '', focus: true, appId: 'app-2' });

  const now = sessions.session('notes')!;
  expect(slugs(sessions)).toEqual(['notes']);
  expect(now.appId).toBe('app-2');
  expect(now.key).not.toBe(first.key);
  expect(now.route).toBe('');
});

test('stopping an App by id finds it under a stale slug', () => {
  const sessions = store();
  sessions.show('notes', { route: '', focus: false, appId: 'app-1' });

  sessions.quitApp('app-1', 'journal');

  expect(slugs(sessions)).toEqual([]);
});
