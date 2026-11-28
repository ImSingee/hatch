import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentNode } from './notification-content';
import {
  ContentError,
  compileCardJsonWith,
  compileCardMarkupWith,
  compileMarkdownWith,
  type JsonNode,
} from './notification-content-compile';
import { CARD_EXAMPLES } from './notification-content-examples';
import { compileCard, compileCardMarkup } from './notification-content-schema';
import { contentToMarkup } from './notification-content-text';

const NO_MARKDOWN = { markdownToBlocks: (): ContentNode[] => [] };

/** The issues compiling reports, or a failure if it compiles. */
function issuesOf(compile: () => unknown) {
  try {
    compile();
  } catch (error) {
    if (error instanceof ContentError) return error.issues;
    throw error;
  }
  throw new Error('expected the content to be rejected');
}

/** `levels` Columns nested inside a Card, the innermost holding text. */
function nestedCard(levels: number): JsonNode {
  let node: JsonNode = { type: 'Text', children: ['x'] };
  for (let level = 0; level < levels; level++) {
    node = { type: 'Column', children: [node] };
  }
  return { type: 'Card', children: [node] };
}

/** The JSON path of the node nested `levels` deep along first children. */
const pathAt = (levels: number) =>
  Array.from({ length: levels }, () => 'children.0').join('.');

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
    // Decimal text too long for a finite number, and whole numbers past
    // what JavaScript holds exactly.
    [
      'Trend',
      { values: `1,${'9'.repeat(400)}` },
      {
        error:
          '<Trend> values Invalid input: expected number, received Infinity',
      },
    ],
    [
      'Trend',
      { values: '1,2', threshold: `-${'9'.repeat(400)}` },
      {
        error:
          '<Trend> threshold Invalid input: expected number, received -Infinity',
      },
    ],
    [
      'Progress',
      { percent: '9'.repeat(400) },
      {
        error:
          '<Progress> percent Invalid input: expected number, received Infinity',
      },
    ],
    [
      'Text',
      { lines: '9007199254740993' },
      { error: '<Text> lines must be a whole number' },
    ],
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

  it('takes only <Card> as the root of a card', () => {
    const document = { type: 'Document', children: [{ type: 'Divider' }] };
    expect(issuesOf(() => compileCardJsonWith(document, NO_MARKDOWN))).toEqual([
      { message: 'a card starts with <Card>, not <Document>', path: 'card' },
    ]);
    expect(
      issuesOf(() =>
        compileCardMarkupWith('<Document><Divider /></Document>', NO_MARKDOWN),
      ),
    ).toEqual([
      {
        message: 'a card starts with <Card>, not <Document>',
        line: 1,
        column: 1,
      },
    ]);
  });

  // Text split into several pieces (by CDATA in markup, or as adjacent
  // strings in a tree) reads as the same text written in one piece, so the
  // canonical markup of a card compiles back to the same card.
  it.each([
    ['markup with CDATA', '<Card><Text>A <![CDATA[ ]]> B</Text></Card>'],
    ['markup of CDATA spaces', '<Card><Text>A<![CDATA[  ]]>B</Text></Card>'],
    [
      'a tree of strings',
      { type: 'Card', children: [{ type: 'Text', children: ['A ', ' B'] }] },
    ],
  ] as const)('collapses whitespace across pieces of text in %s', (_, card) => {
    const { content } = compileCard(card);
    expect(content.children).toEqual([{ type: 'Text', children: ['A B'] }]);
    expect(compileCard(contentToMarkup(content)).content).toEqual(content);
  });

  it('stores a checked copy of Trend values given as a list', () => {
    const values = [1, 2];
    const { content } = compileCardJsonWith(
      { type: 'Card', children: [{ type: 'Trend', props: { values } }] },
      NO_MARKDOWN,
    );
    values.push(3);
    expect(content.children).toEqual([
      { type: 'Trend', props: { values: [1, 2] } },
    ]);
    // oxlint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(compileProp('Trend', { values: sparse })).toEqual({
      error: '<Trend> values Invalid input',
    });
  });

  it('counts the Document root of Markdown against the element limit', () => {
    const blocks = (count: number) => ({
      markdownToBlocks: () =>
        Array.from({ length: count }, () => ({ type: 'Divider' })),
    });
    expect(compileMarkdownWith('x', blocks(199)).children).toHaveLength(199);
    expect(issuesOf(() => compileMarkdownWith('x', blocks(200)))).toEqual([
      {
        message: 'content has more than 200 elements',
        path: 'markdown block 200',
      },
    ]);
  });

  it('reports a required text attribute left blank as missing', () => {
    expect(
      issuesOf(() =>
        compileCardMarkupWith(
          '<Card><Collapse summary=" \n "><Text>x</Text></Collapse></Card>',
          NO_MARKDOWN,
        ),
      ),
    ).toEqual([{ message: '<Collapse> needs summary', line: 1, column: 7 }]);
    expect(compileProp('Collapse', { summary: '\t' })).toEqual({
      error: '<Collapse> needs summary',
    });
  });

  it('reports at most 20 issues for inline inputs', () => {
    const choices = Array.from(
      { length: 25 },
      (_, index) =>
        `<Choice id="c${index}" label="L" min="1"><Option id="a">A</Option></Choice>`,
    ).join('');
    const issues = issuesOf(() =>
      compileCardMarkupWith(`<Card>${choices}</Card>`, NO_MARKDOWN),
    );
    expect(issues).toHaveLength(20);
    expect(issues[0]!.message).toBe('<Choice> min and max need multiple');
  });

  it('rejects a tree nested past the limit without exhausting the stack', () => {
    const tooDeep = {
      message: 'content is nested more than 8 levels deep',
      path: pathAt(9),
    };
    expect(
      issuesOf(() => compileCardJsonWith(nestedCard(20_000), NO_MARKDOWN)),
    ).toEqual([tooDeep]);
    // Under the source size limit, through the shape checks.
    expect(issuesOf(() => compileCard(nestedCard(2_000)))).toEqual([tooDeep]);
    // A little too deep: the other problems are reported too.
    const card = nestedCard(9);
    card.props = { tone: 'loud' };
    expect(issuesOf(() => compileCard(card))).toEqual([
      {
        message:
          '<Card> tone must be one of neutral, info, success, warning, danger, working',
        path: 'props.tone',
      },
      tooDeep,
    ]);
    let quote: ContentNode = { type: 'Text', children: ['x'] };
    for (let level = 0; level < 5_000; level++) {
      quote = { type: 'Quote', children: [quote] };
    }
    expect(
      issuesOf(() =>
        compileMarkdownWith('x', { markdownToBlocks: () => [quote] }),
      ),
    ).toEqual([
      {
        message: 'content is nested more than 8 levels deep',
        path: 'markdown block 1',
      },
    ]);
  });
});
