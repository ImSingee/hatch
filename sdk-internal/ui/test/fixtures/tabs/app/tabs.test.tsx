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
