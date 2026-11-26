import { expect, open, test } from 'nsh/test';

test('opens an item whose value is falsy', async () => {
  const app = await open('./main.tsx');
  await app.setViewport(1200, 800);
  await app.press('Bed 0');
  await app.waitFor('text:Soil of bed 0');
  await app.setViewport(390, 800);
  await app.waitFor('text:Soil of bed 0');
});

test('keeps the list while the wide pane resizes', async () => {
  const app = await open('./main.tsx');
  await app.setViewport(1200, 800);
  await app.type('label:Search beds', 'clay');
  await app.setViewport(1300, 800);
  expect(app.value('label:Search beds')).toBe('clay');
});

test('shows the newly chosen item beside the list', async () => {
  const app = await open('./main.tsx');
  await app.setViewport(1200, 800);
  await app.press('Bed 1');
  await app.waitFor('text:Soil of bed 1');
  await app.press('Bed 2');
  await app.waitFor('text:Soil of bed 2');
  expect(app.shows('text:Soil of bed 1')).toBe(false);
});

test('follows the items as the search filters them', async () => {
  const app = await open('./main.tsx');
  await app.setViewport(1200, 800);
  await app.type('label:Search beds', '2');
  await app.wait(100);
  expect(app.shows('text:Bed 2')).toBe(true);
  expect(app.shows('text:Bed 0')).toBe(false);
});
