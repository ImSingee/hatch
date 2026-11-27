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
  for (const params of [{}, { platform: 'windows' }, { platform: 7 }]) {
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
