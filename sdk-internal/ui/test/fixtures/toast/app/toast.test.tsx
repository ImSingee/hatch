import { expect, open, test } from 'nsh/test';

test('runs the action of a toast and dismisses it', async () => {
  const app = await open('./main.tsx');
  await app.press('Delete note');
  await app.waitFor('text:No notes');
  await app.waitFor('text:Note deleted');
  await app.press('Undo');
  await app.waitFor('text:Water the beans');
  await app.wait(600);
  expect(app.shows('text:Note deleted')).toBe(false);
});

test('keeps a disabled toast action from running', async () => {
  const app = await open('./main.tsx');
  await app.press('Delete quietly');
  await app.waitFor('text:Cannot undo');
  expect(app.enabled('Undo')).toBe(false);
  expect(app.shows('text:Water the beans')).toBe(true);
});
