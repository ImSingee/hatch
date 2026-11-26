import { expect, open, test } from 'nsh/test';

const handlers = {
  'hatch.theme.get': { ok: false, code: 'unavailable', message: 'none' },
  'hatch.nav.setRoute': { ok: true },
  'hatch.nav.setTitle': { ok: true },
};

type App = Awaited<ReturnType<typeof open>>;

/** What the App sent, in order, of one call name. */
function sent(app: App, name: string): unknown[] {
  return app.host
    .calls()
    .filter((call) => call.name === name)
    .map((call) => call.data);
}

const last = (values: unknown[]) => values[values.length - 1];

test('opens the first section at home and names its page', async () => {
  const app = await open('./main.tsx', { host: { handlers } });
  await app.waitFor("text:Today's page");
  await app.waitUntil(() => sent(app, 'hatch.nav.setTitle').length > 0);
  expect(sent(app, 'hatch.nav.setRoute')).toEqual([{ route: '/today' }]);
  expect(last(sent(app, 'hatch.nav.setTitle'))).toEqual({ title: 'Today' });
});

test('opens a deep link on its section and stack page', async () => {
  const app = await open('./main.tsx', {
    host: { handlers, params: { route: '/notes/42' } },
  });
  await app.waitFor('text:Body of note 42');
  await app.waitUntil(
    () =>
      JSON.stringify(last(sent(app, 'hatch.nav.setTitle'))) ===
      JSON.stringify({ title: 'Note 42' }),
  );
  // The address already names what is shown: nothing to report.
  expect(sent(app, 'hatch.nav.setRoute')).toEqual([]);
});

test('reports sections and pushed pages, and the title follows', async () => {
  const app = await open('./main.tsx', { host: { handlers } });
  await app.waitFor("text:Today's page");
  await app.press('label:Notes');
  await app.press('Open note 7');
  await app.waitFor('text:Body of note 7');
  await app.press('label:Back');
  await app.waitFor('Open note 7');
  await app.wait(100);
  expect(sent(app, 'hatch.nav.setRoute')).toEqual([
    { route: '/today' },
    { route: '/notes' },
    { route: '/notes/7' },
    { route: '/notes' },
  ]);
  expect(sent(app, 'hatch.nav.setTitle')).toEqual([
    { title: 'Today' },
    { title: 'Notes' },
    { title: 'Note 7' },
    { title: 'Notes' },
  ]);
});

test('follows the shell to another section and page without echoing it', async () => {
  const app = await open('./main.tsx', { host: { handlers } });
  await app.waitFor("text:Today's page");
  await app.host.send('hatch.nav', { route: '/notes/9' });
  await app.waitFor('text:Body of note 9');
  await app.host.send('hatch.nav', { route: '/today' });
  await app.waitFor("text:Today's page");
  // Switching back keeps the hidden section's page.
  await app.press('label:Notes');
  await app.waitFor('text:Body of note 9');
  await app.wait(100);
  expect(sent(app, 'hatch.nav.setRoute')).toEqual([
    { route: '/today' },
    { route: '/notes/9' },
  ]);
  expect(last(sent(app, 'hatch.nav.setTitle'))).toEqual({ title: 'Note 9' });
});
