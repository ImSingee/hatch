import { expect, open, test } from 'nsh/test';

test('keeps the detail input when the App replaces its record', async () => {
  const app = await open('./main.tsx');
  await app.setViewport(1200, 800);
  await app.press('North bed');
  await app.waitFor('text:Soil is dry');
  await app.type('label:Notes', 'Add compost');
  await app.press('Water all');
  await app.waitFor('text:Soil is wet');
  expect(app.value('label:Notes')).toBe('Add compost');
});
