import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentNode } from './notification-content';
import {
  ContentError,
  compileCardJsonWith,
  compileCardMarkupWith,
} from './notification-content-compile';
import { CARD_EXAMPLES } from './notification-content-examples';
import { compileCardMarkup } from './notification-content-schema';

const NO_MARKDOWN = { markdownToBlocks: (): ContentNode[] => [] };

/** A one-component card with `props`, compiled from a JSON tree. */
function compileProp(type: string, props: Record<string, unknown>) {
  const tree = {
    type: 'Card',
    children: [
      { type, props, ...(type === 'Text' ? { children: ['x'] } : {}) },
    ],
  };
  try {
    const { content } = compileCardJsonWith(tree, NO_MARKDOWN);
    return { props: (content.children![0] as ContentNode).props ?? {} };
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    return {
      error: error.issues.map((issue) => issue.message).join('\n'),
    };
  }
}

describe('the dependency-free card compiler', () => {
  it('imports only modules of this package that import nothing else', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = fs.readFileSync(file, 'utf8');
      for (const [, specifier] of source.matchAll(
        /^(?:import|export)[^'";]*?from '([^']+)'/gm,
      )) {
        expect(specifier, `${path.basename(file)} imports it`).toMatch(/^\.\//);
        visit(path.join(path.dirname(file), `${specifier}.ts`));
      }
    };
    visit(path.join(import.meta.dirname, 'notification-content-compile.ts'));
    expect(seen.size).toBeGreaterThan(1);
  });

  it.each(CARD_EXAMPLES.map((example) => [example.id, example.markup!]))(
    'builds the tree and form the platform stores for the %s example',
    (_id, markup) => {
      expect(compileCardMarkupWith(markup, NO_MARKDOWN)).toEqual(
        compileCardMarkup(markup),
      );
    },
  );

  it('reads a <Markdown> element with the Markdown step it is given', () => {
    const { content } = compileCardMarkupWith(
      '<Card><Markdown>hello *there*</Markdown></Card>',
      {
        markdownToBlocks: (source) => [{ type: 'Text', children: [source] }],
      },
    );
    expect(content.children).toEqual([
      {
        type: 'Markdown',
        props: { source: 'hello *there*' },
        children: [{ type: 'Text', children: ['hello *there*'] }],
      },
    ]);
  });

  // Every kind of prop, as markup text and as JSON values: what senders
  // read when a value is rejected, and the stored form when it is not.
  it.each([
    ['Text', { size: 'lg' }, { props: { size: 'lg' } }],
    ['Text', { size: 'md' }, { props: {} }],
    [
      'Text',
      { size: 3 },
      { error: '<Text> size must be one of xs, sm, md, lg, xl' },
    ],
    ['Text', { mono: true }, { props: { mono: true } }],
    ['Text', { mono: 'true' }, { props: { mono: true } }],
    ['Text', { mono: 'false' }, { props: {} }],
    ['Text', { mono: 'yes' }, { error: '<Text> mono Invalid input' }],
    ['Text', { mono: 1 }, { error: '<Text> mono Invalid input' }],
    ['Text', { lines: ' 3 ' }, { props: { lines: 3 } }],
    [
      'Text',
      { lines: '3.5' },
      { error: '<Text> lines must be a whole number' },
    ],
    ['Text', { lines: 11 }, { error: '<Text> lines must be 1-10' }],
    ['Text', { lines: '1e1' }, { error: '<Text> lines Invalid input' }],
    ['Text', { lines: true }, { error: '<Text> lines Invalid input' }],
    ['Text', { size: '', mono: null }, { props: {} }],
    [
      'Text',
      { tone: 'loud' },
      {
        error:
          '<Text> tone must be one of dimmed, neutral, info, success, warning, danger, working',
      },
    ],
    ['Progress', { percent: '.5' }, { props: { percent: 0.5 } }],
    ['Progress', { percent: 0 }, { props: { percent: 0 } }],
    [
      'Progress',
      { percent: -1 },
      { error: '<Progress> percent must be at least 0' },
    ],
    [
      'Progress',
      { percent: '101' },
      { error: '<Progress> percent must be at most 100' },
    ],
    [
      'Progress',
      { percent: [1] },
      { error: '<Progress> percent Invalid input' },
    ],
    ['Trend', { values: '1, 2 ,3' }, { props: { values: [1, 2, 3] } }],
    ['Trend', { values: [4, 5] }, { props: { values: [4, 5] } }],
    [
      'Trend',
      { values: '1' },
      { error: '<Trend> values must list 2-30 numbers' },
    ],
    [
      'Trend',
      { values: [] },
      { error: '<Trend> values must list 2-30 numbers' },
    ],
    ['Trend', { values: '1,,2' }, { error: '<Trend> values Invalid input' }],
    [
      'Trend',
      { values: ['1', '2'] },
      { error: '<Trend> values Invalid input' },
    ],
    [
      'Collapse',
      { summary: '  Show   logs ' },
      { props: { summary: 'Show logs' } },
    ],
    [
      'Collapse',
      { summary: 'x'.repeat(101) },
      { error: '<Collapse> summary must be at most 100 characters' },
    ],
    ['Collapse', { summary: 5 }, { error: '<Collapse> summary must be text' }],
  ] as const)('%s %j', (type, props, expected) => {
    expect(compileProp(type, props)).toEqual(expected);
  });

  it.each([
    [
      'href',
      'javascript:alert(1)',
      'must be an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link',
    ],
    [
      'href',
      `https://a.b/${'x'.repeat(2048)}`,
      'must be at most 2048 characters',
    ],
    ['href', 7, 'must be a link'],
    [
      'at',
      '2026-13-45',
      'must be an ISO-8601 time such as 2026-11-25T02:14:00Z',
    ],
    ['at', 7, 'must be an ISO-8601 time'],
  ] as const)('<Step> %s %j', (name, value, message) => {
    const tree = {
      type: 'Card',
      children: [
        {
          type: 'Steps',
          children: [
            { type: 'Step', props: { [name]: value }, children: ['x'] },
          ],
        },
      ],
    };
    expect(() => compileCardJsonWith(tree, NO_MARKDOWN)).toThrow(
      `<Step> ${name} ${message}`,
    );
  });

  it.each([
    ['Q', 'must start with a lowercase letter'],
    [3, 'Invalid input: expected string, received number'],
    [[], 'Invalid input: expected string, received array'],
  ] as const)('rejects the field id %j', (id, message) => {
    const tree = {
      type: 'Card',
      children: [{ type: 'Input', props: { id, label: 'Name' } }],
    };
    expect(() => compileCardJsonWith(tree, NO_MARKDOWN)).toThrow(
      `<Input> id ${message}`,
    );
  });

  it('holds inline inputs to the reply form rules', () => {
    const issues = (markup: string) => {
      try {
        compileCardMarkupWith(markup, NO_MARKDOWN);
      } catch (error) {
        if (error instanceof ContentError) return error.message;
        throw error;
      }
      throw new Error('expected the card to be rejected');
    };
    const buttons = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `<Button id="b${index}">B${index}</Button>`,
      ).join('');
    expect(issues(`<Card><Buttons id="q">${buttons(5)}</Buttons></Card>`)).toBe(
      '1:7: <Buttons> buttons fields need 1-4 options',
    );
    expect(
      issues(
        '<Card><Choice id="q" label="Q"><Option id="a">A</Option><Option id="a">B</Option></Choice></Card>',
      ),
    ).toBe('1:57: <Option> duplicate option id "a"');
    expect(
      issues(
        '<Card><Choice id="q" label="Q" multiple max="1"><Option id="a" default>A</Option><Option id="b" default>B</Option></Choice></Card>',
      ),
    ).toBe('1:7: <Choice> default lists more options than maxSelected');
    expect(
      issues(
        `<Card>${Array.from({ length: 11 }, (_, index) => `<Input id="f${index}" label="L" />`).join('')}</Card>`,
      ),
    ).toBe('1:1: <Card> a reply form has at most 10 fields');
  });
});
