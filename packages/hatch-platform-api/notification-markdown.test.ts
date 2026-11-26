import { describe, expect, it } from 'vitest';
import { compileMarkdown, ContentError } from './notification-content-schema';

const blocks = (source: string) => compileMarkdown(source).children;

describe('Markdown notifications', () => {
  it('compile headings, emphasis, code, quotes and rules into the tree', () => {
    expect(
      blocks(
        [
          '# Release',
          '## v12',
          '### Notes',
          '',
          'A **bold**, *quiet* and ~~old~~ `serverless`',
          'line, then a hard  ',
          'break.',
          '',
          '> Watch the cold start.',
          '',
          '---',
          '',
          '```diff',
          '- old',
          '+ new',
          '```',
        ].join('\n'),
      ),
    ).toEqual([
      { type: 'Title', props: { size: 'xl' }, children: ['Release'] },
      { type: 'Title', props: { size: 'lg' }, children: ['v12'] },
      { type: 'Title', children: ['Notes'] },
      {
        type: 'Text',
        children: [
          'A ',
          { type: 'b', children: ['bold'] },
          ', ',
          { type: 'i', children: ['quiet'] },
          ' and ',
          { type: 's', children: ['old'] },
          ' ',
          { type: 'code', children: ['serverless'] },
          ' line, then a hard',
          { type: 'br' },
          'break.',
        ],
      },
      { type: 'Quote', children: ['Watch the cold start.'] },
      { type: 'Divider' },
      {
        type: 'Code',
        props: { language: 'diff' },
        children: ['- old\n+ new'],
      },
    ]);
  });

  it('compile bullet, numbered, nested and task lists', () => {
    expect(
      blocks(
        [
          '- one',
          '  - nested',
          '- two',
          '',
          '1. first',
          '2. second',
          '',
          '- [x] done',
          '- [ ] todo',
        ].join('\n'),
      ),
    ).toEqual([
      {
        type: 'List',
        children: [
          {
            type: 'Item',
            children: [
              'one',
              {
                type: 'List',
                children: [{ type: 'Item', children: ['nested'] }],
              },
            ],
          },
          { type: 'Item', children: ['two'] },
        ],
      },
      {
        type: 'List',
        props: { ordered: true },
        children: [
          { type: 'Item', children: ['first'] },
          { type: 'Item', children: ['second'] },
        ],
      },
      {
        type: 'List',
        children: [
          { type: 'Item', props: { checked: true }, children: ['done'] },
          { type: 'Item', props: { checked: false }, children: ['todo'] },
        ],
      },
    ]);
  });

  it('compile tables with their column alignment', () => {
    expect(
      blocks(
        ['| Metric | v12 |', '| --- | ---: |', '| Cold start | 0.9 s |'].join(
          '\n',
        ),
      ),
    ).toEqual([
      {
        type: 'Table',
        children: [
          {
            type: 'Tr',
            children: [
              { type: 'Th', children: ['Metric'] },
              { type: 'Th', props: { align: 'end' }, children: ['v12'] },
            ],
          },
          {
            type: 'Tr',
            children: [
              { type: 'Td', children: ['Cold start'] },
              { type: 'Td', props: { align: 'end' }, children: ['0.9 s'] },
            ],
          },
        ],
      },
    ]);
  });

  it('turn images into links, show raw HTML as text and drop unsafe links', () => {
    expect(
      blocks(
        [
          '![chart](https://example.com/chart.png) <b>raw</b>',
          '',
          '[ok](https://example.com) [bad](javascript:alert(1)) [ref][r]',
          '',
          '<script>alert(1)</script>',
          '',
          '[r]: hatch://app/orders#/manage',
        ].join('\n'),
      ),
    ).toEqual([
      {
        type: 'Text',
        children: [
          {
            type: 'a',
            props: { href: 'https://example.com/chart.png' },
            children: ['chart'],
          },
          ' <b>raw</b>',
        ],
      },
      {
        type: 'Text',
        children: [
          {
            type: 'a',
            props: { href: 'https://example.com' },
            children: ['ok'],
          },
          ' bad ',
          {
            type: 'a',
            props: { href: 'hatch://app/orders#/manage' },
            children: ['ref'],
          },
        ],
      },
      { type: 'Text', children: ['<script>alert(1)</script>'] },
    ]);
  });

  it('reject empty and oversized sources', () => {
    expect(() => compileMarkdown('  \n')).toThrow(ContentError);
    expect(() => compileMarkdown('x'.repeat(16 * 1024 + 1))).toThrow(
      'markdown must be at most 16 KiB',
    );
  });
});
