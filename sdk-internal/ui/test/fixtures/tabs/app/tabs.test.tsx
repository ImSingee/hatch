import { expect, open, test } from 'nsh/test';

test('selects the first item once items arrive', async () => {
  const app = await open('./main.tsx');
  await app.press('Load beds');
  await app.waitFor('text:North bed');
});

test('falls back to another item when the selected one goes', async () => {
  const app = await open('./main.tsx');
  await app.press('Load beds');
  await app.waitFor('text:North bed');
  await app.press('Remove north');
  await app.waitFor('text:South bed');
  expect(app.shows('text:North bed')).toBe(false);
});

test('keeps the shown item when items are added before it', async () => {
  const app = await open('./main.tsx');
  await app.press('Load beds');
  await app.waitFor('text:North bed');
  await app.press('Add west first');
  await app.wait(100);
  expect(app.shows('text:North bed')).toBe(true);
  expect(app.shows('text:West bed')).toBe(false);
});

test('moves off a chosen item that becomes disabled', async () => {
  const app = await open('./main.tsx');
  await app.press('Load beds');
  await app.press('label:South');
  await app.press('label:North');
  await app.waitFor('text:North bed');
  await app.press('Close north');
  await app.waitFor('text:South bed');
  expect(app.shows('text:North bed')).toBe(false);
});

test('keeps rows and visited tabs when the App passes new arrays', async () => {
  const app = await open('./main.tsx');
  await app.press('Load beds');
  await app.press('label:South');
  await app.type('label:South notes', 'Mulch in May');
  await app.type('label:Note for Bed 1', 'Shady corner');
  // South is visited but hidden while North shows.
  await app.press('label:North');
  await app.press('Refresh beds');
  await app.wait(100);
  expect(app.value('label:Note for Bed 1')).toBe('Shady corner');
  await app.press('label:South');
  expect(app.value('label:South notes')).toBe('Mulch in May');
});
