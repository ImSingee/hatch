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
