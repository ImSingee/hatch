import { describe, expect, it } from 'vitest';
import { CARD_EXAMPLES } from './notification-content-examples';
import {
  compileCard,
  compileCardMarkup,
  ContentError,
  optionalSummarySchema,
  summarySchema,
} from './notification-content-schema';
import { contentToMarkup } from './notification-content-text';
import { notificationReplySchema } from './notification-reply-schema';

function issues(input: unknown): string[] {
  try {
    compileCard(input);
  } catch (error) {
    if (error instanceof ContentError) return error.message.split('\n');
    throw error;
  }
  throw new Error('expected the card to be rejected');
}

describe('card markup', () => {
  it.each(CARD_EXAMPLES.map((example) => [example.id, example.markup!]))(
    'compiles the %s example and reads its canonical markup back to the same tree',
    (_id, markup) => {
      const { content, reply } = compileCardMarkup(markup);
      const canonical = contentToMarkup(content);
      const again = compileCardMarkup(canonical);
      expect(again.content).toEqual(content);
      expect(again.reply).toEqual(reply);
      expect(contentToMarkup(again.content)).toBe(canonical);
    },
  );

  it('writes the same markup for a stored tree whose keys were reordered', () => {
    const { content } = compileCardMarkup(
      '<Card status="Failed" tone="danger" icon="pr"><Progress percent="40" tone="danger" label="Checks" /></Card>',
    );
    // Postgres jsonb returns object keys in its own order.
    const reordered = JSON.parse(
      JSON.stringify(content, (_key, value: unknown) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).reverse())
          : value,
      ),
    );
    expect(contentToMarkup(reordered)).toBe(contentToMarkup(content));
  });

  it('reports syntax errors at their line and column', () => {
    expect(issues('<Card>\n  <Text>a</Txt>\n</Card>')).toEqual([
      '2:10: </Txt> does not match <Text> opened at 2:3',
    ]);
    expect(issues('<Card>\n  <Text a="1"b>x</Text></Card>')).toEqual([
      '2:14: attributes must be separated by whitespace',
    ]);
    expect(issues('<Card><Text>x</Text>')).toEqual([
      '1:1: <Card> is not closed',
    ]);
  });

  it('decodes the predefined and numeric entities and rejects every other one', () => {
    const { content } = compileCardMarkup(
      '<Card><Text>&lt;b&gt; &amp; &quot;&apos; &#169; &#x4E2D;</Text></Card>',
    );
    expect(content.children).toEqual([
      { type: 'Text', children: ['<b> & "\' © 中'] },
    ]);
    expect(issues('<Card><Text>&nbsp;</Text></Card>')[0]).toMatch(
      /^1:13: unknown entity "&nbsp;"/,
    );
  });

  it('refuses document types, entity definitions and processing instructions', () => {
    expect(
      issues(
        '<!DOCTYPE card [<!ENTITY x "boom">]><Card><Text>&x;</Text></Card>',
      ),
    ).toEqual(['1:1: document types and entity definitions are not allowed']);
    expect(issues('<?xml version="1.0"?><Card />')).toEqual([
      '1:1: processing instructions and XML declarations are not allowed',
    ]);
  });

  it('keeps CDATA, drops comments and collapses formatting whitespace', () => {
    const { content } = compileCardMarkup(`<Card>
      <!-- the headline -->
      <Text>
        Ships   <b>today</b>,
        <![CDATA[<not markup>]]>
      </Text>
    </Card>`);
    expect(content.children).toEqual([
      {
        type: 'Text',
        children: [
          'Ships ',
          { type: 'b', children: ['today'] },
          ', <not markup>',
        ],
      },
    ]);
  });

  it('keeps Code as written, without the indentation of the markup around it', () => {
    const { content } = compileCardMarkup(`<Card>
  <Code language="diff">
    - await waitUntilIdle()
    + await waitUntilIdle({ timeout: 30_000 })
  </Code>
</Card>`);
    expect(content.children).toEqual([
      {
        type: 'Code',
        props: { language: 'diff' },
        children: [
          '- await waitUntilIdle()\n+ await waitUntilIdle({ timeout: 30_000 })',
        ],
      },
    ]);
  });

  it('reads back the exact text of Code and Markdown from canonical markup', () => {
    const exact = [
      '    return total;',
      'line one\n\n',
      '  indented\n    more\n',
      'ends with ]]> inside',
    ];
    for (const text of exact) {
      const tree = {
        type: 'Card',
        children: [
          { type: 'Code', children: [text] },
          { type: 'Markdown', children: [`\`\`\`\n${text}\n\`\`\``] },
        ],
      };
      const { content } = compileCard(tree);
      const again = compileCardMarkup(contentToMarkup(content)).content;
      expect(again).toEqual(content);
      expect(again.children![0]).toEqual({ type: 'Code', children: [text] });
    }
    // Ordinary code still reads as plain text in the markup.
    expect(
      contentToMarkup(
        compileCard({
          type: 'Card',
          children: [{ type: 'Code', children: ['a\n  b'] }],
        }).content,
      ),
    ).toBe('<Card>\n  <Code>a\n  b</Code>\n</Card>');
  });

  it('accepts every accepted card again as its canonical markup', () => {
    // Text full of characters that need escaping, written as CDATA.
    const ampersands = `<Card><Code><![CDATA[${'&'.repeat(4000)}]]></Code><Text><![CDATA[${'<'.repeat(4000)}]]></Text></Card>`;
    // Near the limit, minified: the indented form is longer than the source.
    const minified = `<Card>${Array.from({ length: 95 }, (_, i) => `<Box><Text>${'y'.repeat(140)}${i}</Text></Box>`).join('')}</Card>`;
    // A value holding double quotes, written in single quotes.
    const quoted = `<Card><Callout title='${'"'.repeat(100)}'>x</Callout></Card>`;
    for (const markup of [ampersands, minified, quoted]) {
      const { content } = compileCardMarkup(markup);
      const canonical = contentToMarkup(content);
      expect(compileCardMarkup(canonical).content).toEqual(content);
      expect(compileCard(content).content).toEqual(content);
    }
  });

  it('names what is allowed where a component, prop or value is wrong', () => {
    expect(issues('<Card>\n  <Badges />\n</Card>')[0]).toBe(
      '2:3: <Badges> is not a component; allowed inside <Card>: Column, Row, Grid, Box, Divider, Spacer, Collapse, Title, Text, Caption, Markdown, Badge, Icon, Progress, Stat, Fields, Steps, List, Table, Quote, Code, Trend, Callout, Choice, Buttons, Button, Input, Submit',
    );
    expect(issues('<Card><Fields><Text>x</Text></Fields></Card>')).toEqual([
      '1:15: <Text> cannot go inside <Fields>; allowed inside <Fields>: Field',
    ]);
    expect(issues('<Card color="red" />')).toEqual([
      '1:7: <Card> has no "color" attribute; allowed: icon, status, tone, flag',
    ]);
    expect(
      issues('<Card><Steps><Step state="ok">x</Step></Steps></Card>'),
    ).toEqual([
      '1:20: <Step> state must be one of done, failed, running, pending, skipped',
    ]);
    expect(issues('<Card>\n  loose text\n</Card>')).toEqual([
      '1:7: text cannot go directly inside <Card>; wrap it in <Text>',
    ]);
    expect(issues('<Text>x</Text>')).toEqual([
      '1:1: a card starts with <Card>, not <Text>',
    ]);
  });

  it('accepts only links a notification may open', () => {
    expect(
      issues('<Card><Text><a href="javascript:alert(1)">x</a></Text></Card>'),
    ).toEqual([
      '1:16: <a> href must be an absolute URL that opens a page or app, such as https://, mailto: or a hatch:// link',
    ]);
    expect(() =>
      compileCardMarkup(
        '<Card><Text><a href="hatch://app/orders#/manage">x</a></Text></Card>',
      ),
    ).not.toThrow();
  });

  it('holds markup to the size, element and depth limits', () => {
    // Content is measured as compact canonical markup, source before parsing.
    const big = `<Card>${`<Code>${'x'.repeat(3900)}</Code>`.repeat(5)}</Card>`;
    expect(issues(big)).toEqual([
      'the card must be at most 16 KiB as compact markup; it is 20 KiB',
    ]);
    expect(issues(`<Card>${' '.repeat(64 * 1024)}</Card>`)).toEqual([
      'card markup must be at most 64 KiB',
    ]);
    // The card is the first of the 200 elements.
    const many = `<Card>${'<Divider />'.repeat(200)}</Card>`;
    expect(issues(many)).toEqual([
      '1:2196: content has more than 200 elements',
    ]);
    const deep = `<Card>${'<Box>'.repeat(9)}${'</Box>'.repeat(9)}</Card>`;
    expect(issues(deep)).toEqual([
      '1:47: content is nested more than 8 levels deep',
    ]);
  });

  it('reads a JSON tree like markup and reports problems by path', () => {
    const tree = {
      type: 'Card',
      props: { status: 'Synced', tone: 'success' },
      children: [
        { type: 'Title', children: ['Orders synced'] },
        { type: 'Text', children: ['1,204 written\n1 duplicate skipped'] },
      ],
    };
    expect(compileCard(tree).content).toEqual({
      type: 'Card',
      props: { status: 'Synced', tone: 'success' },
      children: [
        { type: 'Title', children: ['Orders synced'] },
        {
          type: 'Text',
          children: ['1,204 written', { type: 'br' }, '1 duplicate skipped'],
        },
      ],
    });
    expect(compileCard(JSON.stringify(tree)).content).toEqual(
      compileCard(tree).content,
    );
    expect(
      issues({
        type: 'Card',
        children: [{ type: 'Progress', props: { percent: 120 } }, 'loose'],
      }),
    ).toEqual([
      'children.0.props.percent: <Progress> percent must be at most 100',
      'children.1: text cannot go directly inside <Card>; wrap it in <Text>',
    ]);
  });
});

describe('a stored tree', () => {
  it('is accepted back as a JSON tree, Markdown inside a card included', () => {
    const { content } = compileCardMarkup(
      '<Card><Markdown>- **one**\n- two</Markdown><Text>end</Text></Card>',
    );
    // As envelopes and `get --json` hand it out.
    const stored = JSON.parse(JSON.stringify(content));
    expect(compileCard(stored).content).toEqual(content);
  });
});

describe('inline inputs', () => {
  it('compile into the same reply form as the one written by hand', () => {
    const { reply } = compileCardMarkup(`<Card status="Alert" tone="danger">
  <Choice id="plan" label="What now?" required>
    <Option id="rollback" note="1 min" then-status="Rolling back">Roll back</Option>
    <Option id="raise" badge="fast" default>Raise the limit</Option>
  </Choice>
  <Input id="why" label="Why?" placeholder="Optional" multiline />
  <Choice id="notify" label="Tell" multiple>
    <Option id="team" default>The team</Option>
    <Option id="oncall" default>On-call</Option>
    <Option id="nobody">Nobody</Option>
  </Choice>
  <Row justify="end"><Submit>Confirm</Submit></Row>
</Card>`);
    const byHand = notificationReplySchema.parse({
      submitLabel: 'Confirm',
      fields: [
        {
          id: 'plan',
          type: 'single',
          label: 'What now?',
          required: true,
          default: 'raise',
          options: [
            { id: 'rollback', label: 'Roll back', note: '1 min' },
            { id: 'raise', label: 'Raise the limit', badge: 'fast' },
          ],
        },
        {
          id: 'why',
          type: 'text',
          label: 'Why?',
          required: false,
          placeholder: 'Optional',
          multiline: true,
        },
        {
          id: 'notify',
          type: 'multiple',
          label: 'Tell',
          required: false,
          default: ['team', 'oncall'],
          options: [
            { id: 'team', label: 'The team' },
            { id: 'oncall', label: 'On-call' },
            { id: 'nobody', label: 'Nobody' },
          ],
        },
      ],
    });
    expect(reply).toEqual(byHand);
  });

  it('make a row of buttons a required question without a label', () => {
    const { reply } = compileCardMarkup(`<Card>
  <Row justify="between">
    <Button href="https://example.com/pr/258">View PR</Button>
    <Buttons id="next">
      <Button id="fix" primary>Fix it</Button>
      <Button id="drop" destructive>Drop</Button>
    </Buttons>
  </Row>
</Card>`);
    expect(reply).toEqual({
      submitLabel: 'Submit',
      fields: [
        {
          id: 'next',
          type: 'buttons',
          label: '',
          required: true,
          options: [
            { id: 'fix', label: 'Fix it', primary: true },
            { id: 'drop', label: 'Drop', destructive: true },
          ],
        },
      ],
    });
  });

  it('are rejected at the element that breaks the form rules', () => {
    expect(
      issues(`<Card>
  <Choice id="plan" label="Q"><Option id="a">A</Option></Choice>
</Card>`),
    ).toEqual(['2:3: <Choice> single fields need 2-50 options']);
    expect(
      issues(`<Card>
  <Buttons id="x"><Button id="a">A</Button></Buttons>
  <Buttons id="x"><Button id="b">B</Button></Buttons>
</Card>`),
    ).toEqual(['3:3: <Buttons> duplicate field id "x"']);
    expect(issues('<Card><Button id="go">Go</Button></Card>')).toEqual([
      '1:7: <Button> outside <Buttons> is a link: give it href only; answer buttons go inside <Buttons>',
    ]);
    expect(issues('<Card><Submit>Send</Submit></Card>')).toEqual([
      '1:7: <Submit> needs a <Choice>, <Buttons> or <Input> to submit',
    ]);
  });

  it('leave a card without inputs without a form', () => {
    expect(
      compileCardMarkup('<Card><Text>Done</Text></Card>').reply,
    ).toBeNull();
  });
});

describe('summary', () => {
  it('is one trimmed line of at most 200 characters', () => {
    expect(summarySchema.parse('  CI failed on PR #261  ')).toBe(
      'CI failed on PR #261',
    );
    expect(
      summarySchema.safeParse('two\nlines').error?.issues[0]?.message,
    ).toBe('summary must be one line, without line breaks');
    expect(summarySchema.safeParse('中'.repeat(200)).success).toBe(true);
    expect(summarySchema.safeParse('   ').error?.issues[0]?.message).toBe(
      'summary must not be empty',
    );
    // As an optional field, blank text means no summary at all.
    expect(optionalSummarySchema.parse(' \t ')).toBeNull();
    expect(
      summarySchema.safeParse('中'.repeat(201)).error?.issues[0]?.message,
    ).toBe('summary must be at most 200 characters');
  });
});
