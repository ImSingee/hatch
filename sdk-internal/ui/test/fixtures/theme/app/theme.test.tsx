import { expect, open, test } from 'nsh/test';

const TEAL = '#0F766E';
const CLAY = '#B4472A';
const WINDOW = '#FAF9F6';

const theme = (primary: string, fonts: Record<string, string> = {}) => ({
  cssVars: { theme: fonts, light: { primary } },
});

const NUNITO = { 'font-sans': 'Nunito, PingFang SC, system-ui, sans-serif' };

/** `#rrggbb` of a view's background, as NSH reports `#rrggbbaa`. */
function fill(app: Awaited<ReturnType<typeof open>>, selector: string) {
  return (app.viewStyle(selector)?.backgroundColor ?? '')
    .slice(0, 7)
    .toUpperCase();
}

test('follows the shell theme from hatch.theme.get and hatch.theme', async () => {
  const app = await open('./main.tsx', {
    platform: 'web',
    host: {
      handlers: { 'hatch.theme.get': { ok: true, theme: theme(TEAL) } },
    },
  });
  await app.waitUntil(() => fill(app, 'label:Save') === TEAL);
  await app.host.send('hatch.theme', { theme: theme(CLAY) });
  expect(fill(app, 'label:Save')).toBe(CLAY);
  // A theme with only the accent keeps every other token of the Desk theme.
  expect(fill(app, 'label:Theme')).toBe(WINDOW);
});

test('keeps the built-in theme when the shell answers an error', async () => {
  const app = await open('./main.tsx', {
    platform: 'web',
    host: {
      handlers: {
        'hatch.theme.get': {
          ok: false,
          code: 'unavailable',
          message: 'offline',
        },
      },
    },
  });
  await app.wait(300);
  expect(fill(app, 'label:Save')).toBe('#3F51C7');
});

test("keeps the platform's font under the shell theme on iOS", async () => {
  const app = await open('./main.tsx', {
    platform: 'ios',
    host: {
      handlers: { 'hatch.theme.get': { ok: true, theme: theme(TEAL, NUNITO) } },
    },
  });
  await app.waitUntil(() => fill(app, 'label:Save') === TEAL);
  // No family: the system font.
  expect(app.spanStyle('text:Save').fontFamily ?? '').toBe('');
  await app.host.send('hatch.theme', { theme: theme(CLAY, NUNITO) });
  expect(fill(app, 'label:Save')).toBe(CLAY);
  expect(app.spanStyle('text:Save').fontFamily ?? '').toBe('');
});

test('draws the shell theme font on the web', async () => {
  const app = await open('./main.tsx', {
    platform: 'web',
    host: {
      handlers: { 'hatch.theme.get': { ok: true, theme: theme(TEAL, NUNITO) } },
    },
  });
  await app.waitUntil(() => fill(app, 'label:Save') === TEAL);
  expect(String(app.spanStyle('text:Save').fontFamily).split(',')[0]).toBe(
    'Nunito',
  );
});
