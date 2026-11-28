/**
 * The Desk draws each example card and the Markdown example with the same
 * structure as the renderer-neutral outline: the same controls and
 * landmarks, in order, with the same names and checked states, and every
 * text the outline lists. Shown as a preview: no live form, nothing
 * answered, so inputs show the sender's defaults.
 */
import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { utils } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';
import type { ContentNode } from '../../../packages/hatch-platform-api/notification-content';
import {
  CARD_EXAMPLES,
  MARKDOWN_EXAMPLE,
} from '../../../packages/hatch-platform-api/notification-content-examples';
import {
  contentOutline,
  outlineText,
  type OutlineEntry,
} from '../../../packages/hatch-platform-api/notification-content-outline';
import {
  compileCardMarkup,
  compileMarkdown,
} from '../../../packages/hatch-platform-api/notification-content-schema';
import { NotificationContent } from './notification-content-view';

// Server Functions cannot load in the browser project.
vi.mock('~server/notifications', () => ({
  respondToNotificationFn: async () => ({}),
}));
vi.mock('~queries/notifications', () => ({ NOTIFICATIONS_KEY: ['n'] }));

type Difference = {
  /** Entries that differ, by position; absent where one has none. */
  entries?: { at: number; outline?: OutlineEntry; desk?: OutlineEntry }[];
  /** Outline texts the Desk does not show. */
  missingTexts?: string[];
};

/**
 * Where the Desk knowingly differs from the outline, by example id.
 * Anything not listed here must match.
 */
const KNOWN_DIFFERENCES: Record<string, Difference> = {};

const EXAMPLES: { id: string; content: ContentNode }[] = [
  ...CARD_EXAMPLES.map((example) => ({
    id: example.id,
    content: compileCardMarkup(example.markup!).content,
  })),
  {
    id: MARKDOWN_EXAMPLE.id,
    content: compileMarkdown(MARKDOWN_EXAMPLE.markdown!),
  },
];

/** The outline role an element plays, read from the element itself. */
function roleOf(element: Element): OutlineEntry['role'] | null {
  const role = element.getAttribute('role');
  if (role === 'radio' || role === 'checkbox' || role === 'button') {
    return role;
  }
  if (/^H[1-6]$/.test(element.tagName)) return 'heading';
  switch (element.tagName) {
    case 'A':
      if (!element.hasAttribute('href')) return null;
      // A Mantine Button drawn as an anchor: the link button.
      return element.classList.contains('mantine-Button-root')
        ? 'button'
        : 'link';
    case 'BUTTON':
      return 'button';
    case 'INPUT': {
      const type = (element as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      return type === 'text' ? 'textbox' : null;
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'PROGRESS':
      return 'progressbar';
    case 'TH':
      return 'columnheader';
    case 'TD':
      return 'cell';
    default:
      return null;
  }
}

/**
 * The rendered content as an outline: its controls and landmarks in
 * document order, named as an assistive technology names them, leaving out
 * what is hidden from it.
 */
function deskEntries(container: Element): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const element of container.querySelectorAll('*')) {
    const role = roleOf(element);
    if (!role) continue;
    // The accessibility tree of the element alone: nothing when hidden.
    const node = utils.aria
      .generateAriaTree(element)
      .children.find((child) => typeof child !== 'string');
    if (!node) continue;
    const name = outlineText(node.name);
    entries.push(
      role === 'radio' || role === 'checkbox'
        ? { role, name, checked: node.checked === true }
        : { role, name },
    );
  }
  return entries;
}

test('draws every example with the structure of its outline', async () => {
  const screen = await render(
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      {EXAMPLES.map(({ id, content }) => (
        <section key={id} data-example={id}>
          <NotificationContent
            format={content.type === 'Card' ? 'card' : 'markdown'}
            content={content}
          />
        </section>
      ))}
    </MantineProvider>,
  );
  const found: Record<string, Difference> = {};
  for (const { id, content } of EXAMPLES) {
    const section = screen.container.querySelector<HTMLElement>(
      `[data-example="${id}"]`,
    )!;
    const outline = contentOutline(content);
    const difference: Difference = {};
    const desk = deskEntries(section);
    const entries: NonNullable<Difference['entries']> = [];
    for (let at = 0; at < Math.max(desk.length, outline.entries.length); at++) {
      const [want, got] = [outline.entries[at], desk[at]];
      if (JSON.stringify(want) === JSON.stringify(got)) continue;
      entries.push({
        at,
        ...(want ? { outline: want } : {}),
        ...(got ? { desk: got } : {}),
      });
    }
    if (entries.length > 0) difference.entries = entries;
    const shown = outlineText(section.innerText);
    const missing = outline.texts.filter((text) => !shown.includes(text));
    if (missing.length > 0) difference.missingTexts = missing;
    if (Object.keys(difference).length > 0) found[id] = difference;
  }
  expect(found).toEqual(KNOWN_DIFFERENCES);
});
