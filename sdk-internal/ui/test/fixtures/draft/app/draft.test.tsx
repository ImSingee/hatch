import { expect, open, test } from 'nsh/test';

const KEY = 'hatch.ui.draft.note';

test('saves unsent input as a draft, without passwords', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Title', 'Half a thought');
  await app.type('label:Secret', 'hunter2');
  await app.wait(800);
  const saved = JSON.parse(app.storage()[KEY] ?? '{}');
  expect(saved.title).toBe('Half a thought');
  expect(saved.secret).toBe(undefined);
});

test('restores the draft when the App starts again', async () => {
  const app = await open('./main.tsx', {
    storage: { [KEY]: JSON.stringify({ title: 'Kept while stopped' }) },
  });
  await app.waitFor('text:Restored your unsent changes.');
  expect(app.value('label:Title')).toBe('Kept while stopped');
});

test('deletes the draft once the form is sent', async () => {
  const app = await open('./main.tsx', {
    storage: { [KEY]: JSON.stringify({ title: 'Ready' }) },
  });
  await app.waitFor('text:Restored your unsent changes.');
  await app.press('Send');
  await app.waitFor('text:Sent');
  expect(app.storage()[KEY]).toBe(undefined);
});

test('does not save sent values again as a draft', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Title', 'Done');
  await app.press('Send');
  await app.waitFor('text:Sent');
  await app.setLifecycle('background');
  await app.wait(800);
  expect(app.storage()[KEY]).toBe(undefined);
});

test('keeps clearing a value as a draft and restores it', async () => {
  const app = await open('./main.tsx');
  await app.clear('label:Plant');
  await app.wait(800);
  const saved = JSON.parse(app.storage()['hatch.ui.draft.plant'] ?? '{}');
  expect(saved.plant).toBe('');
  const again = await open('./main.tsx', {
    storage: { 'hatch.ui.draft.plant': JSON.stringify(saved) },
  });
  await again.waitFor('text:Restored your unsent changes.');
  expect(again.value('label:Plant')).toBe('');
});

test('sends and checks the value of a field the App controls', async () => {
  const app = await open('./main.tsx');
  await app.press('Save');
  await app.waitFor('text:Saved plant=Fern bed=North bed');
  expect(app.shows('text:Fill in this field.')).toBe(false);
});
