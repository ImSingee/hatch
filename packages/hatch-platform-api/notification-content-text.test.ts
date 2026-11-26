import { describe, expect, it } from 'vitest';
import { answeredCardHead, notificationHeadline } from './notification-content';
import { CARD_EXAMPLES } from './notification-content-examples';
import { compileCardMarkup } from './notification-content-schema';
import { contentToPlainText } from './notification-content-text';

const card = (markup: string) => compileCardMarkup(markup).content;
const example = (id: string) =>
  card(CARD_EXAMPLES.find((entry) => entry.id === id)!.markup!);

describe('plain text of a tree', () => {
  it('gives every component a readable line', () => {
    expect(
      contentToPlainText(
        card(`<Card status="Incident" flag="Urgent">
  <Title>Order sync <i>stopped</i></Title>
  <Text>See <a href="https://example.com/log">the log</a> at <time datetime="2026-11-25T02:14:00Z" />.<br/>Second line</Text>
  <Caption>Updated <code>10:52</code></Caption>
  <Row><Badge tone="danger">+12%</Badge><Icon name="alert" /></Row>
  <Progress label="Checks" value="3 / 14" percent="21" />
  <Progress percent="40" />
  <Grid><Stat value="0.02%" label="Errors" delta="-0.4%" /><Stat value="1.01 s" label="P95" /></Grid>
  <Fields><Field label="Branch">fix/login</Field></Fields>
  <Steps>
    <Step state="done" detail="41 s">types</Step>
    <Step state="failed" at="2026-11-25T02:20:00Z">unit</Step>
    <Step state="running">e2e</Step>
    <Step>deploy</Step>
    <Step state="skipped">backfill</Step>
  </Steps>
  <List ordered><Item>Roll back</Item><Item>Raise <b>limit</b></Item></List>
  <List><Item checked>Done</Item><Item checked="false">Todo</Item><Item>Plain<List><Item>Nested</Item></List></Item></List>
  <Table><Tr><Th>Metric</Th><Th>v12</Th></Tr><Tr><Td>Cold</Td><Td>0.9 s</Td></Tr></Table>
  <Quote author="Bryan" location="idle.ts:142">No upper bound.</Quote>
  <Code>step 3
  detail</Code>
  <Trend values="1,2,3" unit="ms" label="Latency" />
  <Callout title="Heads up">Cold starts are slower.</Callout>
  <Collapse summary="3 changes"><Text>Fix redirect</Text></Collapse>
  <Divider />
  <Spacer />
  <Box><Markdown>**Bold** move</Markdown></Box>
  <Choice id="plan" label="What now?">
    <Option id="a" note="1 min">Roll back</Option>
    <Option id="b">Wait</Option>
  </Choice>
  <Input id="why" label="Why?" />
  <Buttons id="next" label="Next step"><Button id="fix">Fix it</Button><Button id="later">Later</Button></Buttons>
  <Button href="https://example.com/pr">View PR</Button>
  <Submit>Send</Submit>
</Card>`),
      ),
    ).toBe(
      [
        'Incident · Urgent',
        'Order sync stopped',
        'See the log (https://example.com/log) at 2026-11-25 02:14 UTC.',
        'Second line',
        'Updated 10:52',
        '+12%',
        'Checks: 3 / 14',
        '40%',
        'Errors: 0.02% (-0.4%)',
        'P95: 1.01 s',
        'Branch: fix/login',
        '✓ types (41 s)',
        '✗ unit (2026-11-25 02:20 UTC)',
        '… e2e',
        '○ deploy',
        '– backfill',
        '1. Roll back',
        '2. Raise limit',
        '[x] Done',
        '[ ] Todo',
        '- Plain',
        '  - Nested',
        'Metric | v12',
        'Cold | 0.9 s',
        'Bryan · idle.ts:142',
        '> No upper bound.',
        'step 3\n  detail',
        'Latency: 1, 2, 3 (ms)',
        'Heads up',
        'Cold starts are slower.',
        '3 changes',
        'Fix redirect',
        'Bold move',
        'What now?',
        '- Roll back (1 min)',
        '- Wait',
        'Why?',
        'Next step',
        '[Fix it] [Later]',
        'View PR: https://example.com/pr',
      ].join('\n'),
    );
  });
});

describe('what a card shows in its fixed places', () => {
  const content = example('alert');
  const answered = (editedAt: string | null) =>
    answeredCardHead({
      content,
      answers: { plan: 'raise' },
      respondedAt: '2026-11-25T10:00:00Z',
      editedAt,
    });

  it('shows the chosen option’s status and puts the flag away after an answer', () => {
    expect(answered(null)).toEqual({
      status: { label: '调整中', tone: 'working' },
      flag: null,
      icon: 'app',
    });
  });

  it('goes back to what the sender wrote once the sender edits the card', () => {
    expect(answered('2026-11-25T10:05:00Z')).toEqual({
      status: { label: '异常', tone: 'danger' },
      flag: '紧急',
      icon: 'app',
    });
  });
});

describe('the headline', () => {
  it('is the title of a text notification and the summary of the others', () => {
    expect(
      notificationHeadline({
        format: 'text',
        title: 'Backup done',
        summary: 'Nightly',
      }),
    ).toBe('Backup done');
    expect(
      notificationHeadline({
        format: 'card',
        title: null,
        summary: 'CI failed',
      }),
    ).toBe('CI failed');
  });
});
