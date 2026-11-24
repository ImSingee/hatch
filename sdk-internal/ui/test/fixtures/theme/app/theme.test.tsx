import { expect, open, test } from 'nsh/test';

const TEAL = '#0F766E';
const CLAY = '#B4472A';
const WINDOW = '#FAF9F6';

const theme = (primary: string) => ({
  cssVars: { theme: {}, light: { primary } },
});

/** `#rrggbb` of a view's background, as NSH reports `#rrggbbaa`. */
function fill(app: Awaited<ReturnType<typeof open>>, selector: string) {
  return (app.viewStyle(selector)?.backgroundColor ?? '')
    .slice(0, 7)
    .toUpperCase();
}

test('follows the shell theme from hatch.theme.get and hatch.theme', async () => {
  const app = await open('./main.tsx', {
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
