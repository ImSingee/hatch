import { expect, open, test } from 'nsh/test';
import type { Platform } from 'nsh/test';

const handlers = {
  'hatch.theme.get': { ok: false, code: 'unavailable', message: 'none' },
  'hatch.nav.setTitle': { ok: true },
  'hatch.nav.setRoute': { ok: true },
};

/** Opens the App on `platform`, with the shell's `host.params`. */
async function openOn(platform: Platform, params: Record<string, unknown>) {
  const app = await open('./main.tsx', {
    platform,
    host: { params, handlers },
  });
  await app.waitFor('text:Garden notes');
  return app;
}

type App = Awaited<ReturnType<typeof openOn>>;

const height = (app: App, selector: string) => app.layout(selector)?.height;

/** The look the App took: its page title's type and font, and the heights
 * of a button, a text field, a list row and a tab. */
function look(app: App) {
  const title = app.spanStyle('text:Garden notes');
  return {
    title: [title.fontSize, title.fontWeight],
    font: String(title.fontFamily ?? '')
      .split(',')[0]
      .trim(),
    button: height(app, 'label:Save'),
    field: height(app, 'label:Name'),
    row: height(app, 'label:North bed'),
    tab: height(app, 'label:Notes'),
  };
}

// NSH reports no family for the system font, SF Pro on iOS.
const IOS = {
  title: [34, 700],
  font: '',
  button: 44,
  field: 44,
  row: 44,
  tab: 52,
};
const ANDROID = {
  title: [22, 500],
  font: 'Roboto',
  button: 48,
  field: 54,
  row: 56,
  tab: 80,
};

// The desktops keep the pointer sizes: macOS's 13-point body and 28-point
// controls, Fluent's 32-point ones and 28-point page title. NSH reports no
// family for the system font (SF Pro); Windows names Segoe UI Variable.
const MACOS = {
  title: [22, 700],
  font: '',
  button: 28,
  // The input inside the well's 1-point border.
  field: 26,
  row: 40,
  tab: 30,
};
const WINDOWS = {
  title: [28, 600],
  font: 'Segoe UI Variable',
  button: 32,
  field: 30,
  row: 40,
  tab: 36,
};

/** Opens the App in a pane wide enough for the sidebar. */
async function openWide(platform: Platform, params: Record<string, unknown>) {
  const app = await open('./main.tsx', {
    platform,
    width: 1024,
    height: 768,
    host: { params, handlers },
  });
  await app.waitFor('text:Garden notes');
  return app;
}

test('takes the macOS and Windows looks from NSH on those desktops', async () => {
  expect(look(await openWide('macos', {}))).toEqual(MACOS);
  expect(look(await openWide('windows', {}))).toEqual(WINDOWS);
});

test('takes macOS and Windows from the web shell', async () => {
  expect(look(await openWide('web', { platform: 'macos' }))).toEqual(MACOS);
  expect(look(await openWide('web', { platform: 'windows' }))).toEqual(WINDOWS);
});

test('hides and shows the sidebar on macOS only', async () => {
  const app = await openWide('macos', {});
  await app.press('label:Hide sidebar');
  await app.waitUntil(() => !app.shows('role:tab >> text:Settings'));
  await app.press('label:Show sidebar');
  await app.waitFor('role:tab >> text:Settings');
  const windows = await openWide('windows', {});
  expect(windows.shows('label:Hide sidebar')).toBe(false);
});

test('takes the iOS look from NSH on iOS', async () => {
  expect(look(await openOn('ios', {}))).toEqual(IOS);
});

test('takes the Android look from NSH on Android', async () => {
  expect(look(await openOn('android', {}))).toEqual(ANDROID);
});

test('lets NSH decide over the shell outside the web', async () => {
  expect(look(await openOn('ios', { platform: 'android' }))).toEqual(IOS);
});

test('takes the platform the web shell passes', async () => {
  // The headless page measures a desktop idiom, which keeps the top tabs:
  // the layout follows the idiom, the look the platform.
  const { tab: _ios, ...ios } = IOS;
  const { tab: _android, ...android } = ANDROID;
  expect(look(await openOn('web', { platform: 'ios' }))).toMatchObject(ios);
  expect(look(await openOn('web', { platform: 'android' }))).toMatchObject(
    android,
  );
});

test('keeps the web look in a browser and for other shells', async () => {
  for (const params of [{}, { platform: 'linux' }, { platform: 7 }]) {
    const app = await openOn('web', params);
    const title = app.spanStyle('text:Garden notes');
    expect([title.fontWeight, String(title.fontFamily).split(',')[0]]).toEqual([
      800,
      'Nunito',
    ]);
  }
});

test('opens a sheet with Cancel at the top on iOS only', async () => {
  for (const [platform, cancel] of [
    ['ios', true],
    ['android', false],
  ] as const) {
    const app = await openOn(platform, {});
    await app.press('label:Filter');
    await app.waitFor('text:Filter plants');
    expect(app.shows('label:Cancel')).toBe(cancel);
    if (cancel) {
      await app.press('label:Cancel');
      await app.waitUntil(() => !app.shows('text:Filter plants'));
    }
  }
});

test('updates a bar action when its icon goes and comes', async () => {
  for (const platform of ['ios', 'android'] as const) {
    const app = await openOn(platform, {});
    // An action with an icon shows the icon alone in the bar.
    expect(app.shows('text:Edit')).toBe(false);
    await app.press('label:Edit');
    await app.waitFor('text:Done');
    await app.press('label:Done');
    await app.waitUntil(() => !app.shows('text:Done'));
  }
});

test('scrolls the last row clear of the iOS tab bar after the pane narrows', async () => {
  const app = await open('./main.tsx', {
    platform: 'ios',
    width: 800,
    height: 600,
    host: { params: {}, handlers },
  });
  await app.waitFor('text:Garden notes');
  await app.setViewport(390, 600);
  await app.waitFor('role:tab >> text:Notes');
  await app.scroll('label:Garden notes', 4000);
  const last = app.layout('text:Bed 14');
  const tab = app.layout('label:Notes');
  // The row ends above the bar, whose tabs sit 6 points into it.
  const rowBottom = (last?.y ?? 0) + (last?.height ?? 0);
  const barTop = (tab?.y ?? 0) - 6;
  expect([rowBottom <= barTop, rowBottom, barTop]).toEqual([
    true,
    rowBottom,
    barTop,
  ]);
});

test('draws iOS gray buttons on the fill opposite the card they sit on', async () => {
  const app = await openOn('ios', {});
  const fill = (label: string) =>
    (app.viewStyle(`label:${label}`)?.backgroundColor ?? '').slice(0, 7);
  // The theme's ground (`background`), not the card's white.
  expect(['Water', 'Log', 'Share'].map(fill)).toEqual([
    '#edebe6',
    '#edebe6',
    '#edebe6',
  ]);
});
