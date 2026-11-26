/**
 * The timeline over several pages: it opens at the newest and marks it read,
 * keeps what is in view still while older pages load above, and the unread
 * jump loads older pages until it reaches where reading stopped. A card that
 * asks inline is answered in place and then shows the answer read-only.
 */
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import {
  QueryClient,
  QueryClientProvider,
  infiniteQueryOptions,
  queryOptions,
} from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { CARD_EXAMPLES } from '../../../../packages/hatch-platform-api/notification-content-examples';
import { compileCardMarkup } from '../../../../packages/hatch-platform-api/notification-content-schema';
import type { ReplyAnswers } from '../../../../packages/hatch-platform-api/notification-reply';
import { appCssVariablesResolver, appTheme } from '~/ui/theme';
import type { NotificationSummaryView } from '~server/notifications';
import { NotificationTimeline } from './timeline';

const PAGE = 50;

const fixtures = vi.hoisted(() => ({
  items: [] as NotificationSummaryView[],
  readState: {
    readThroughId: null as string | null,
    readThroughAt: '',
    unreadCount: 0,
    firstUnreadId: null as string | null,
  },
  pagesRequested: 0,
  markRead: [] as string[],
  revisions: {} as Record<string, unknown[]>,
  answers: [] as { id: string; round: number; answers: ReplyAnswers }[],
}));

// Server Functions cannot load in the browser project.
vi.mock('~server/notifications', () => ({
  markNotificationsReadFn: async ({
    data,
  }: {
    data: { notificationId: string };
  }) => {
    fixtures.markRead.push(data.notificationId);
    return { ...fixtures.readState, unreadCount: 0, firstUnreadId: null };
  },
  respondToNotificationFn: async ({
    data,
  }: {
    data: { id: string; round: number; answers: ReplyAnswers };
  }) => {
    fixtures.answers.push(data);
    // A new object, as from the platform, so the refetch shows it.
    const index = fixtures.items.findIndex((entry) => entry.id === data.id);
    const respondedAt = new Date().toISOString();
    fixtures.items[index] = {
      ...fixtures.items[index]!,
      respondedAt,
      response: {
        round: data.round,
        answers: data.answers,
        respondedBy: { userId: 'user-1', name: 'Ada' },
        via: 'web',
        destinationId: null,
        respondedAt,
      },
    };
    return {};
  },
  retryDeliveryFn: async () => ({}),
}));
vi.mock('~queries/notifications', () => {
  const key = ['notifications'] as const;
  return {
    NOTIFICATIONS_KEY: key,
    // Newest activity first, like the platform; the cursor is an offset.
    notificationTimelineQueryOptions: infiniteQueryOptions({
      queryKey: [...key, 'timeline'],
      queryFn: async ({ pageParam }) => {
        fixtures.pagesRequested += 1;
        const newest = [...fixtures.items].reverse();
        const start = pageParam ?? 0;
        return {
          items: newest.slice(start, start + PAGE),
          nextCursor: start + PAGE < newest.length ? start + PAGE : null,
        };
      },
      initialPageParam: 0 as number | null,
      getNextPageParam: (page) => page.nextCursor,
    }),
    notificationReadStateQueryOptions: queryOptions({
      queryKey: [...key, 'read-state'],
      queryFn: async () => fixtures.readState,
    }),
    notificationRevisionsQueryOptions: (id: string) =>
      infiniteQueryOptions({
        queryKey: [...key, 'revisions', id],
        queryFn: async () => ({
          revisions: (fixtures.revisions[id] ?? []) as never[],
          responses: [] as never[],
          nextCursor: null as string | null,
        }),
        initialPageParam: null as string | null,
        getNextPageParam: (page) => page.nextCursor,
      }),
    notificationDetailQueryOptions: (id: string) =>
      queryOptions({
        queryKey: [...key, 'detail', id],
        queryFn: async () => null,
      }),
  };
});
vi.mock('~components/notifications/use-notification-read-state', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  const { notificationReadStateQueryOptions } =
    await import('~queries/notifications');
  return {
    useNotificationReadState: () => useQuery(notificationReadStateQueryOptions),
  };
});
vi.mock('~auth/client', () => ({
  authClient: { useSession: () => ({ data: { user: { id: 'user-1' } } }) },
}));
vi.mock('~components/apps/use-app-icon', () => ({
  appIconUrl: () => '',
  useAppIconKey: () => null,
  useHasAppIcons: () => false,
}));

function notification(index: number): NotificationSummaryView {
  const at = new Date(Date.now() - (200 - index) * 60_000).toISOString();
  const id = `n${String(index).padStart(3, '0')}`;
  return {
    id,
    sourceType: 'channel',
    sourceId: 'channel-1',
    sourceName: 'GitHub',
    kind: 'pr',
    kindName: 'Pull request',
    format: 'text',
    title: `Notification ${index}`,
    body: 'Two lines of body text so each card has some height to it.',
    summary: null,
    markdown: null,
    content: null,
    url: null,
    autoOpenUrl: false,
    priority: 0,
    occurredAt: at,
    createdAt: at,
    activityAt: at,
    revision: 1,
    earlierVersions: 0,
    editedAt: null,
    recalledAt: null,
    reply: null,
    replyRound: 1,
    respondedAt: null,
    response: null,
    status: 'delivered',
    deliveries: { pending: 0, succeeded: 1, failed: 0, canceled: 0 },
  };
}

beforeEach(() => {
  fixtures.items = Array.from({ length: 120 }, (_, index) =>
    notification(index),
  );
  fixtures.readState = {
    readThroughId: null,
    readThroughAt: new Date(0).toISOString(),
    unreadCount: 0,
    firstUnreadId: null,
  };
  fixtures.pagesRequested = 0;
  fixtures.markRead = [];
  fixtures.revisions = {};
  fixtures.answers = [];
});

async function renderTimeline(height = 600, width?: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const screen = await render(
    <MantineProvider
      theme={appTheme}
      cssVariablesResolver={appCssVariablesResolver}
    >
      <ModalsProvider>
        <QueryClientProvider client={queryClient}>
          <div
            style={{ height, width, display: 'flex', flexDirection: 'column' }}
          >
            <NotificationTimeline />
          </div>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>,
  );
  const scroller = () =>
    document.querySelector<HTMLElement>(
      'section[aria-label="Notification timeline"]',
    )!;
  const article = (index: number) =>
    document.querySelector<HTMLElement>(
      `article[aria-label="GitHub: Notification ${index}"]`,
    );
  return { screen, scroller, article, queryClient };
}

test('opens at the newest and marks it read, and holds the view while older pages load', async () => {
  fixtures.readState.unreadCount = 1;
  fixtures.readState.firstUnreadId = 'n119';
  const { scroller, article } = await renderTimeline();
  await vi.waitFor(() => expect(article(119)).not.toBeNull());
  await vi.waitFor(() => {
    const view = scroller();
    expect(view.scrollHeight - view.scrollTop - view.clientHeight).toBeLessThan(
      2,
    );
  });
  await vi.waitFor(() => expect(fixtures.markRead).toEqual(['n119']));

  // Scrolling to the top loads the page before, without moving the oldest
  // loaded notification on screen.
  const view = scroller();
  view.scrollTop = 0;
  view.dispatchEvent(new Event('scroll'));
  const before = article(70)!.getBoundingClientRect().top;
  await vi.waitFor(() => expect(article(69)).not.toBeNull());
  await vi.waitFor(() =>
    expect(
      Math.abs(article(70)!.getBoundingClientRect().top - before),
    ).toBeLessThan(4),
  );
});

test('the jump loads older pages until it reaches the first unread notification', async () => {
  fixtures.readState.unreadCount = 115;
  fixtures.readState.firstUnreadId = 'n005';
  const { screen } = await renderTimeline();
  const jump = screen.getByRole('button', {
    name: '115 unread · Jump to where you left off',
  });
  await expect.element(jump).toBeVisible();
  await jump.click();
  await expect.element(screen.getByText('115 unread below')).toBeInViewport();
  expect(fixtures.pagesRequested).toBe(3);
  await expect.element(jump).not.toBeInTheDocument();
});

test('keeps loading older pages while the reader is already at the top', async () => {
  // A window tall enough that a page never fills it: the reader is at the
  // top without scrolling, and can scroll no further to ask for more.
  const { article } = await renderTimeline(40_000);
  await vi.waitFor(() => expect(article(0)).not.toBeNull());
  expect(fixtures.pagesRequested).toBe(3);
});

test('gives paging back when the jump runs out of pages before the first unread', async () => {
  fixtures.items = Array.from({ length: 1200 }, (_, index) =>
    notification(index),
  );
  fixtures.readState.unreadCount = 1200;
  fixtures.readState.firstUnreadId = fixtures.items[0]!.id;
  const { screen, scroller } = await renderTimeline();
  const jump = screen.getByRole('button', {
    name: '1200 unread · Jump to where you left off',
  });
  await jump.click();
  // One page on opening and twenty for the jump, without reaching it.
  await expect.element(jump).toBeVisible();
  expect(fixtures.pagesRequested).toBe(21);

  // Scrolling to the top loads older pages again.
  const view = scroller();
  view.scrollTop = 0;
  view.dispatchEvent(new Event('scroll'));
  await vi.waitFor(() => expect(fixtures.pagesRequested).toBeGreaterThan(21));
});

test('opens every version of an edited or recalled notification beside the timeline', async () => {
  fixtures.items = Array.from({ length: 3 }, (_, index) => notification(index));
  const edited = fixtures.items[2]!;
  const ciCard = (status: string, tone: string, text: string) =>
    compileCardMarkup(
      `<Card icon="pr" status="${status}" tone="${tone}"><Title>PR #261</Title><Text>${text}</Text></Card>`,
    ).content;
  Object.assign(edited, {
    format: 'card',
    title: null,
    body: null,
    summary: 'PR #261 can be merged',
    content: ciCard('CI passed', 'success', 'All 14 checks passed.'),
    editedAt: edited.activityAt,
    earlierVersions: 1,
  });
  fixtures.revisions[edited.id] = [
    {
      revision: 1,
      format: 'card',
      title: null,
      body: null,
      summary: 'PR #261 failed CI',
      markdown: null,
      content: ciCard('CI failed', 'danger', '2 checks failed.'),
      url: null,
      autoOpenUrl: false,
      data: null,
      reply: null,
      replyRound: 1,
      activityAt: fixtures.items[0]!.activityAt,
      replacedAt: edited.activityAt,
    },
  ];
  const recalled = fixtures.items[1]!;
  recalled.recalledAt = recalled.activityAt;
  const { screen } = await renderTimeline();

  await screen
    .getByRole('button', { name: 'Edited 1 time · View history' })
    .click();
  const panel = screen.getByRole('complementary', { name: 'Earlier versions' });
  // A card is named by its summary where its content is not shown.
  await expect
    .element(panel.getByRole('heading', { name: 'PR #261 can be merged' }))
    .toBeVisible();
  await expect.element(panel.getByText('Current')).toBeVisible();
  await expect.element(panel.getByText('Original')).toBeVisible();
  await expect.element(panel.getByText('2 checks failed.')).toBeVisible();
  await expect.element(panel.getByText('CI failed')).toBeVisible();
  await expect
    .element(
      panel.getByText(
        'Changed from the version before: Status · Summary · Content',
      ),
    )
    .toBeVisible();

  await screen
    .getByRole('button', { name: /GitHub recalled “Notification 1”/ })
    .click();
  await expect.element(panel.getByText('Before the recall')).toBeVisible();
  await expect
    .element(panel.getByText(/GitHub recalled this notification at/))
    .toBeVisible();

  await screen.getByRole('button', { name: 'Close earlier versions' }).click();
  await expect.element(panel).not.toBeInTheDocument();
});

test('covers the timeline with the versions panel on a narrow window, reading nothing behind it', async () => {
  fixtures.items = Array.from({ length: 3 }, (_, index) => notification(index));
  fixtures.items[2]!.earlierVersions = 1;
  const { screen, scroller, queryClient } = await renderTimeline(600, 600);
  const opener = screen.getByRole('button', {
    name: 'Edited 1 time · View history',
  });
  await opener.click();
  await expect
    .element(screen.getByRole('complementary', { name: 'Earlier versions' }))
    .toBeVisible();
  // Focus moves into the panel, and the covered timeline is out of reach.
  await expect
    .element(screen.getByRole('button', { name: 'Close earlier versions' }))
    .toHaveFocus();
  expect(scroller().inert).toBe(true);

  // Something new arrives while the panel hides the timeline.
  queryClient.setQueryData(['notifications', 'read-state'], {
    ...fixtures.readState,
    unreadCount: 1,
    firstUnreadId: fixtures.items[2]!.id,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(fixtures.markRead).toEqual([]);

  await screen.getByRole('button', { name: 'Close earlier versions' }).click();
  expect(scroller().inert).toBe(false);
  await expect.element(opener).toHaveFocus();
  await vi.waitFor(() => expect(fixtures.markRead).toEqual(['n002']));
});

test('gives the timeline back when the shown notification goes away, and focus to a button clicked without focusing it', async () => {
  fixtures.items = Array.from({ length: 3 }, (_, index) => notification(index));
  fixtures.items[2]!.earlierVersions = 1;
  const { screen, scroller, queryClient } = await renderTimeline(600, 600);
  const opener = screen.getByRole('button', {
    name: 'Edited 1 time · View history',
  });
  await expect.element(opener).toBeVisible();

  // Safari leaves focus where it was when a button is clicked.
  (document.activeElement as HTMLElement | null)?.blur();
  opener.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const close = screen.getByRole('button', { name: 'Close earlier versions' });
  await expect.element(close).toHaveFocus();
  await close.click();
  await expect.element(opener).toHaveFocus();

  await opener.click();
  await expect.element(close).toHaveFocus();
  expect(scroller().inert).toBe(true);
  // Deleted from another client: the timeline refreshes without it.
  fixtures.items = fixtures.items.slice(0, 2);
  await queryClient.refetchQueries({ queryKey: ['notifications', 'timeline'] });
  await expect
    .element(screen.getByRole('complementary', { name: 'Earlier versions' }))
    .not.toBeInTheDocument();
  await vi.waitFor(() => expect(scroller().inert).toBe(false));
});

test('answers the inputs a card holds inline, then shows the answer in place', async () => {
  const alert = CARD_EXAMPLES.find((example) => example.id === 'alert')!;
  const compiled = compileCardMarkup(alert.markup!);
  const item = notification(0);
  Object.assign(item, {
    sourceName: alert.sourceName,
    kindName: alert.kindName,
    format: 'card',
    title: null,
    body: null,
    summary: alert.summary,
    content: compiled.content,
    reply: compiled.reply,
  });
  fixtures.items = [item];
  const { screen } = await renderTimeline();
  const card = screen.getByRole('article', {
    name: `${alert.sourceName}: ${alert.summary}`,
  });
  await expect.element(card.getByText('紧急')).toBeVisible();
  const raise = card.getByRole('radio', { name: /把内存上限提到 1 GB/ });
  await raise.click();
  await card.getByRole('button', { name: '确认' }).click();

  await vi.waitFor(() =>
    expect(fixtures.answers).toEqual([
      { id: item.id, round: 1, answers: { plan: 'raise' } },
    ]),
  );
  // Answered: the choice stays in place read-only, the chosen option's
  // status replaces the card's, and the outcome is drawn below it.
  await expect
    .element(card.getByText('You answered “把内存上限提到 1 GB” on the web'))
    .toBeVisible();
  await expect.element(raise).toBeChecked();
  await expect.element(raise).toBeDisabled();
  await expect.element(card.getByText('调整中')).toBeVisible();
  await expect.element(card.getByText('紧急')).not.toBeInTheDocument();
  await expect
    .element(card.getByRole('button', { name: '确认' }))
    .not.toBeInTheDocument();
});

test('a card whose last question is a row of buttons sends its other inputs with the button', async () => {
  const review = CARD_EXAMPLES.find((example) => example.id === 'pr258')!;
  const compiled = compileCardMarkup(review.markup!);
  const item = notification(0);
  Object.assign(item, {
    format: 'card',
    title: null,
    body: null,
    summary: review.summary,
    content: compiled.content,
    reply: compiled.reply,
  });
  fixtures.items = [item];
  const { screen } = await renderTimeline();
  const card = screen.getByRole('article', {
    name: `GitHub: ${review.summary}`,
  });
  // The link button only opens the pull request.
  await expect
    .element(card.getByRole('link', { name: '查看 PR' }))
    .toHaveAttribute('href', 'https://github.com/ImSingee/hatch/pull/258');
  await card.getByRole('textbox').fill('上限 30 秒');
  await card.getByRole('button', { name: '修复它' }).click();
  await screen.getByRole('button', { name: 'Send answer' }).click();
  await vi.waitFor(() =>
    expect(fixtures.answers).toEqual([
      { id: item.id, round: 1, answers: { how: '上限 30 秒', next: 'fix' } },
    ]),
  );
  await expect.element(card.getByRole('textbox')).toHaveValue('上限 30 秒');
  await expect.element(card.getByRole('textbox')).toHaveAttribute('readonly');
  await expect.element(card.getByText('修复中')).toBeVisible();
});
