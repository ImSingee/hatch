/**
 * Every component of the content catalog renders: each designed card and the
 * Markdown example, compiled by the shared compiler the platform uses, plus a
 * card for what they leave out. Types a newer sender might use render their
 * children or nothing, never an error.
 */
import { MantineProvider } from '@mantine/core';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';
import {
  CONTENT_COMPONENTS,
  walkContent,
  type ContentNode,
} from '../../../packages/hatch-platform-api/notification-content';
import {
  CARD_EXAMPLES,
  MARKDOWN_EXAMPLE,
} from '../../../packages/hatch-platform-api/notification-content-examples';
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

/** What the designed cards and the Markdown example do not use. */
const REST = `<Card icon="bug" status="Checked" tone="info" flag="Urgent">
  <Column gap="xs" align="start">
    <Title size="xl" lines="2">Every <i>other</i> <s>part</s><br/>of the catalog</Title>
    <Caption tone="success">Caption <Badge tone="warning">inline</Badge> <Icon name="database" tone="danger" /></Caption>
  </Column>
  <Spacer size="lg" />
  <Box surface="outline" padding="sm" tone="success">
    <Text mono lines="1">ord_8841</Text>
  </Box>
  <Icon name="message" />
  <Badge tone="info">block</Badge>
  <Grid columns="4" gap="lg">
    <Stat value="0.02%" label="Error rate" delta="-0.4%" tone="success" />
    <Stat value="1.01 s" label="P95" delta="+62%" tone="danger" />
  </Grid>
  <Steps>
    <Step state="failed" href="https://example.com/log">Verify on preview</Step>
    <Step state="skipped" detail="Skipped">Backfill</Step>
  </Steps>
  <List ordered>
    <Item>Roll back to v11</Item>
    <Item>Raise the limit</Item>
  </List>
  <Code language="diff">  await stopped(instance)
- await waitUntilIdle()
+ await waitUntilIdle({ timeout: 30_000 })</Code>
  <Markdown>- [x] migrated
- [ ] backfilled

> **Bryan**: no upper bound

---

1. first</Markdown>
  <Callout tone="danger">No title, <a href="hatch://app/orders">open orders</a></Callout>
  <Row justify="end">
    <Button href="https://example.com/pr">Open PR</Button>
  </Row>
</Card>`;

function trees(): ContentNode[] {
  return [
    ...CARD_EXAMPLES.map(
      (example) => compileCardMarkup(example.markup!).content,
    ),
    compileMarkdown(MARKDOWN_EXAMPLE.markdown!),
    compileCardMarkup(REST).content,
  ];
}

async function renderContent(nodes: ContentNode[]) {
  return render(
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      {nodes.map((content, index) => (
        <section key={index} aria-label={`content ${index}`}>
          <NotificationContent
            format={content.type === 'Card' ? 'card' : 'markdown'}
            content={content}
          />
        </section>
      ))}
    </MantineProvider>,
  );
}

test('renders every component of the catalog', async () => {
  const all = trees();
  const used = new Set(
    all.flatMap((tree) => [...walkContent(tree)].map(({ node }) => node.type)),
  );
  // Held to the catalog: a new component needs an example here.
  expect(
    CONTENT_COMPONENTS.map((spec) => spec.name).filter(
      (name) => !used.has(name),
    ),
  ).toEqual([]);

  const errors = vi.spyOn(console, 'error');
  const screen = await renderContent(all);
  for (const index of all.keys()) {
    await expect
      .element(screen.getByRole('region', { name: `content ${index}` }))
      .toBeVisible();
  }
  const rest = screen.getByRole('region', {
    name: `content ${all.length - 1}`,
  });
  await expect.element(rest.getByText('Urgent')).toBeVisible();
  await expect.element(rest.getByText('Failed')).toBeInTheDocument();
  await expect
    .element(rest.getByRole('link', { name: 'Verify on preview' }))
    .toHaveAttribute('href', 'https://example.com/log');
  await expect
    .element(rest.getByRole('link', { name: 'Open PR' }))
    .toHaveAttribute('target', '_blank');
  await expect
    .element(rest.getByRole('checkbox', { name: 'migrated' }))
    .toBeChecked();
  // A collapsed section opens on click.
  const release = screen.getByRole('region', {
    name: `content ${CARD_EXAMPLES.findIndex((example) => example.id === 'release')}`,
  });
  await release.getByRole('button', { name: '查看 3 项改动' }).click();
  await expect
    .element(release.getByText('后端改用 serverless 模式'))
    .toBeVisible();
  const spending = screen.getByRole('region', {
    name: `content ${CARD_EXAMPLES.findIndex((example) => example.id === 'spending')}`,
  });
  await expect
    .element(spending.getByText(/最近 7 天: ¥210, ¥180/))
    .toBeInTheDocument();
  expect(errors).not.toHaveBeenCalled();
});

test('renders the children of types it does not know and skips the rest', async () => {
  const screen = await renderContent([
    {
      type: 'Card',
      children: [
        { type: 'Carousel', children: [{ type: 'Text', children: ['kept'] }] },
        { type: 'Hologram', props: { size: 'xl' } },
        {
          type: 'Text',
          children: [{ type: 'sparkle', children: ['inline kept'] }],
        },
      ],
    },
  ]);
  await expect.element(screen.getByText('kept', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('inline kept')).toBeVisible();
});
