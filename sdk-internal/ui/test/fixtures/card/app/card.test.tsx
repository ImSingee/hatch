import { expect, open, test } from 'nsh/test';
import type { AccessibilityNode, Platform } from 'nsh/test';
import { compileCard } from '@hatch/ui/card';
import cases from './cases.json';
import markdown from './markdown.json';

type Entry = { role: string; name: string; checked?: boolean };
type Case = {
  id: string;
  markup: string;
  outline: { entries: Entry[]; texts: string[] };
};
type MarkdownCase = { source: string; blocks: unknown };

const handlers = {
  'hatch.theme.get': { ok: false, code: 'unavailable', message: 'none' },
  'hatch.nav.setTitle': { ok: true },
  'hatch.nav.setRoute': { ok: true },
};

/** Every look: iOS and Android natively, the web, macOS and Windows as the
 * shells name them. */
const LOOKS: [Platform, Record<string, unknown>][] = [
  ['ios', {}],
  ['android', {}],
  ['web', {}],
  ['web', { platform: 'macos' }],
  ['web', { platform: 'windows' }],
];

const ROLES: Record<string, string> = {
  header: 'heading',
  link: 'link',
  button: 'button',
  radio: 'radio',
  checkbox: 'checkbox',
  textbox: 'textbox',
  progressbar: 'progressbar',
  columnheader: 'columnheader',
  cell: 'cell',
};

/** The card's controls and landmarks, as the outline names them. */
function outlineOf(root: AccessibilityNode | null): Entry[] {
  const entries: Entry[] = [];
  const walk = (node: AccessibilityNode) => {
    // NSH reports a text input by its label alone, without a role; nothing
    // else in a card has a label and no role.
    const role = node.role
      ? ROLES[node.role]
      : node.label
        ? 'textbox'
        : undefined;
    if (role) {
      const entry: Entry = {
        role,
        name: node.name.replace(/\s+/g, ' ').trim(),
      };
      if (role === 'radio' || role === 'checkbox') {
        entry.checked = node.checked === 'true';
      }
      entries.push(entry);
    }
    for (const child of node.children) walk(child);
  };
  if (root) walk(root);
  return entries;
}

const squeeze = (text: string) => text.replace(/\s+/g, '');

async function openCard(platform: Platform, params: Record<string, unknown>) {
  const app = await open('./main.tsx', {
    platform,
    host: { params, handlers },
  });
  await app.waitFor('text:Card');
  return app;
}

test('draws every example with the outline the platform gives it, on every look', async () => {
  for (const [platform, params] of LOOKS) {
    for (const entry of cases as Case[]) {
      const app = await openCard(platform, { ...params, example: entry.id });
      const where = `${entry.id} on ${params.platform ?? platform}`;
      // NSH's accessibility tree holds views, and a link inside a paragraph
      // is a span of its text: links are checked by pressing them below.
      expect([where, outlineOf(app.accessibility('id:card'))]).toEqual([
        where,
        entry.outline.entries.filter((item) => item.role !== 'link'),
      ]);
      for (const link of entry.outline.entries.filter(
        (item) => item.role === 'link',
      )) {
        await app.press(`text:${link.name}`);
        expect([
          where,
          app.texts().some((text) => text.startsWith('submitted: link ')),
        ]).toEqual([where, true]);
      }
      const shown = squeeze(app.texts().join(''));
      const missing = entry.outline.texts.filter(
        (text) => !shown.includes(squeeze(text)),
      );
      expect([where, missing]).toEqual([where, []]);
    }
  }
});

test('draws a card written in TSX as its markup', async () => {
  const tsx = await openCard('web', { example: 'tsx-deploy' });
  const markup = await openCard('web', { example: 'deploy' });
  expect(outlineOf(tsx.accessibility('id:card'))).toEqual(
    outlineOf(markup.accessibility('id:card')),
  );
  expect(tsx.texts()).toEqual(markup.texts());
});

test('sends the answers of the last row of buttons, with the other questions', async () => {
  const app = await openCard('web', { example: 'form' });
  await app.press('label:Dusk');
  await app.type('label:Note', 'after the rain');
  await app.press('label:Water now');
  await app.waitFor(
    'text:submitted: {"slot":"dusk","note":"after the rain","go":"now"}',
  );
  // Answered: read-only, the flag put away, no option's status to show.
  expect(app.shows('text:Urgent')).toBe(false);
  expect(app.enabled('label:Later')).toBe(false);
});

test('asks for a required answer before sending', async () => {
  const app = await openCard('web', { example: 'form' });
  await app.press('label:Water now');
  await app.waitFor('text:Choose an answer.');
  expect(app.shows('text:submitted: none')).toBe(true);
  await app.press('label:Dawn');
  await app.press('label:Water now');
  await app.waitFor('text:At dawn');
});

test('shows why the App refused the answers, and stays answerable', async () => {
  const app = await openCard('web', { example: 'form-failing' });
  await app.press('label:Dawn');
  await app.press('label:Water now');
  await app.waitFor('text:The valve did not answer.');
  expect(app.enabled('label:Later')).toBe(true);
});

test('takes answers again after a submit when repeatable', async () => {
  const app = await openCard('web', { example: 'form-repeatable' });
  await app.press('label:Dawn');
  await app.press('label:Later');
  await app.waitFor('text:submitted: {"slot":"dawn","go":"later"}');
  expect(app.enabled('label:Water now')).toBe(true);
});

test('sends no answer for an input the App took away', async () => {
  const app = await openCard('web', { example: 'form-removable' });
  await app.type('label:Extra', 'typed before it went');
  await app.press('label:Skip the note');
  await app.waitFor('text:No note needed');
  await app.press('label:Send');
  await app.waitFor('text:submitted: {}');
});

test('takes no other answer while a submit is pending', async () => {
  const app = await openCard('web', { example: 'form-pending' });
  await app.press('label:Option A');
  await app.press('label:Send');
  await app.waitUntil(() => !app.enabled('label:Option B'));
  expect(app.enabled('label:Option A')).toBe(false);
});

test('lays every block of a grid out in its columns', async () => {
  const app = await openCard('web', { example: 'layout' });
  const one = app.layout('text:Cell one')!;
  const two = app.layout('text:Cell two')!;
  const three = app.layout('text:Cell three')!;
  expect(two.x).toBeGreaterThan(one.x);
  expect(two.y).toBe(one.y);
  expect(three.x).toBe(one.x);
  expect(three.y).toBeGreaterThan(one.y);
});

test('opens the address a link button shows now', async () => {
  const app = await openCard('web', { example: 'layout' });
  await app.press('label:Next page');
  await app.press('label:Open page');
  await app.waitFor('text:submitted: link hatch://app/notes#/two');
});

test('shows an answer given elsewhere read-only, with its status', async () => {
  const app = await openCard('web', {
    example: 'perm',
    answers: JSON.stringify({ decision: 'once' }),
  });
  await app.waitFor('text:已批准一次');
  expect(app.shows('text:等你批准')).toBe(false);
  expect(app.enabled('label:允许')).toBe(false);
});

test('reads Markdown as the platform does', () => {
  for (const entry of markdown as MarkdownCase[]) {
    const result = compileCard(
      `<Card><Markdown><![CDATA[${entry.source}]]></Markdown></Card>`,
    );
    expect([
      entry.source,
      result.ok ? result.content.children : result.issues,
    ]).toEqual([entry.source, entry.blocks]);
  }
});
