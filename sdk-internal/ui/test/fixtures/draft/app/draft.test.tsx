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

test('sends what every field shows: controlled values and defaults', async () => {
  const app = await open('./main.tsx');
  await app.press('Save');
  await app.waitFor('text:Saved plant=Fern bed=North bed mulch=false');
  expect(app.shows('text:Fill in this field.')).toBe(false);
});

test('keeps a password out of the draft after its field goes', async () => {
  const app = await open('./main.tsx');
  await app.type('label:PIN', '4921');
  await app.press('Hide PIN');
  await app.type('label:Nickname', 'Ivy');
  await app.wait(800);
  const saved = JSON.parse(app.storage()['hatch.ui.draft.account'] ?? '{}');
  expect(saved.nickname).toBe('Ivy');
  expect(saved.pin).toBe(undefined);
});

test('shows a switch error from the form', async () => {
  const app = await open('./main.tsx');
  await app.press('Continue');
  await app.waitFor('text:Agree to continue.');
  await app.press('label:I agree');
  await app.press('Continue');
  await app.waitFor('text:Agreed');
});

test('follows a field whose name changes', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Call me', 'Ivy');
  await app.press('Use nickname');
  // The new name already had a value, which is kept; the old name is gone.
  expect(app.value('label:Call me')).toBe('Ivy G');
  await app.press('Save name');
  await app.waitFor('text:Named nick=Ivy G');
});

test('a send that ends after its form closed keeps a newer draft', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Memo', 'First memo');
  await app.press('Send memo');
  await app.press('Close memo');
  await app.press('Open memo');
  // The unfinished send left its text as a draft; the new form restores it.
  await app.waitFor('text:Restored your unsent changes.');
  await app.clear('label:Memo');
  await app.type('label:Memo', 'Second memo');
  await app.wait(800);
  await app.press('Finish sending');
  await app.wait(300);
  const saved = JSON.parse(app.storage()['hatch.ui.draft.memo'] ?? '{}');
  expect(saved.memo).toBe('Second memo');
});

test('input made after a send stays a draft when the form closes', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Memo', 'Sent memo');
  await app.press('Send memo');
  await app.clear('label:Memo');
  await app.type('label:Memo', 'Edited after sending');
  await app.press('Close memo');
  await app.press('Finish sending');
  await app.wait(300);
  const saved = JSON.parse(app.storage()['hatch.ui.draft.memo'] ?? '{}');
  expect(saved.memo).toBe('Edited after sending');
});

test('a send that ends after its form closed removes what it sent', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Memo', 'Only this');
  await app.press('Send memo');
  await app.press('Close memo');
  await app.press('Finish sending');
  await app.wait(300);
  expect(app.storage()['hatch.ui.draft.memo']).toBe(undefined);
});

test('a send that ends after its form closed leaves an open form its draft', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Memo', 'Same memo');
  await app.press('Send memo');
  await app.press('Close memo');
  await app.press('Open memo');
  // The new form restores the unfinished send's text as its own draft.
  await app.waitFor('text:Restored your unsent changes.');
  await app.press('Finish sending');
  await app.wait(300);
  const saved = JSON.parse(app.storage()['hatch.ui.draft.memo'] ?? '{}');
  expect(saved.memo).toBe('Same memo');
});

test('a newer form keeps its draft after it closes too', async () => {
  const app = await open('./main.tsx');
  await app.type('label:Memo', 'Same memo');
  await app.press('Send memo');
  await app.press('Close memo');
  await app.press('Open memo');
  await app.waitFor('text:Restored your unsent changes.');
  await app.press('Close memo');
  await app.press('Finish sending');
  await app.wait(300);
  const saved = JSON.parse(app.storage()['hatch.ui.draft.memo'] ?? '{}');
  expect(saved.memo).toBe('Same memo');
});

test('a newer form made while a late send reads the draft keeps it', async () => {
  // Storage stands in for the device's, with the late send's read of the
  // draft held for 200 ms; the form is reopened 50 ms into that read.
  const store = new Map<string, string>();
  const held = { armed: false, released: false };
  const app = await open('./main.tsx', {
    modules: {
      nsh: {
        'Storage.getItem': (key: string) => {
          const value = store.get(key) ?? null;
          if (!held.armed || key !== 'hatch.ui.draft.memo') return value;
          held.armed = false;
          return new Promise((resolve) =>
            setTimeout(() => {
              held.released = true;
              resolve(store.get(key) ?? null);
            }, 200),
          );
        },
        'Storage.setItem': (key: string, value: string) => {
          store.set(key, value);
        },
        'Storage.removeItem': (key: string) => {
          store.delete(key);
        },
      },
    },
  });
  await app.type('label:Memo', 'Same memo');
  await app.press('Send memo');
  await app.press('Close memo');
  await app.wait(100);
  expect(store.get('hatch.ui.draft.memo')).toBe('{"memo":"Same memo"}');
  held.armed = true;
  await app.press('Finish and reopen');
  await app.waitUntil(() => held.released);
  await app.waitFor('text:Restored your unsent changes.');
  await app.wait(100);
  expect(store.get('hatch.ui.draft.memo')).toBe('{"memo":"Same memo"}');
});
