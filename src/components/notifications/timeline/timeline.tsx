import { Button, Center, Loader, Tooltip } from '@mantine/core';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconArrowBackUp,
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconBellOff,
  IconCheck,
  IconChevronRight,
  IconHistory,
  IconX,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { describeAnswers } from '../../../../packages/hatch-platform-api/notification-reply';
import { authClient } from '~auth/client';
import { UserAvatar } from '~components/auth/user-avatar';
import { AppGlyph } from '~components/apps/app-glyph';
import { EmptyState } from '~components/page/page';
import { useI18n, type Locale } from '~/i18n';
import { useEventCallback } from '~hooks/use-latest-committed';
import { formatExact } from '~lib/format';
import {
  notificationReadStateQueryOptions,
  notificationTimelineQueryOptions,
} from '~queries/notifications';
import { markNotificationsReadFn } from '~server/notifications';
import { CardBlock, CardStatus } from '../notification-card-view';
import { NotificationHistory } from '../notification-history';
import { NotificationLink } from '../notification-link';
import { ReplySection } from '../reply-section';
import { useNotificationReadState } from '../use-notification-read-state';
import {
  buildTimelineRows,
  nextMovedMarkers,
  type MovedMarker,
} from '../../../../packages/hatch-platform-api/notification-timeline';
import type { NotificationSummaryView } from '~server/notifications';

/** A notification as the timeline shows it, oldest first. */
type TimelineItem = NotificationSummaryView;
import classes from './timeline.module.css';

/** How close to the end, in px, still counts as reading the newest. */
const AT_END = 80;
/** How close to the top, in px, loads the next older page. */
const NEAR_TOP = 240;
/** How long the newest must stay in view before it counts as read, in ms. */
const READ_AFTER = 600;
/** Most older pages a jump loads to reach the first unread notification. */
const JUMP_PAGES = 20;

/**
 * Remember where notifications were before their source moved them, while
 * this page stays open.
 */
function useMovedMarkers(items: TimelineItem[]): MovedMarker[] {
  const [tracked, setTracked] = useState({
    items,
    markers: [] as MovedMarker[],
  });
  if (tracked.items !== items) {
    const markers =
      tracked.items.length === 0
        ? []
        : nextMovedMarkers(tracked.items, items, tracked.markers);
    setTracked({ items, markers });
    return markers;
  }
  return tracked.markers;
}

/**
 * Every notification as one stream, oldest at the top. It opens at the
 * newest, follows new notifications while the reader is at the end, and
 * loads older pages when they scroll up. What was unread when it opened is
 * marked by a divider with a jump back to it; reaching the end marks
 * everything read on every device.
 */
export function NotificationTimeline() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const query = useInfiniteQuery(notificationTimelineQueryOptions);
  const readState = useNotificationReadState();
  const pages = query.data?.pages;
  const items = useMemo(
    () => (pages ?? []).flatMap((page) => page.items).reverse(),
    [pages],
  );
  const moved = useMovedMarkers(items);

  // What was unread when the page opened stays marked while it is open.
  const [opened, setOpened] = useState<{
    firstUnreadId: string | null;
    count: number;
  } | null>(null);
  if (opened === null && readState.data) {
    setOpened({
      firstUnreadId: readState.data.firstUnreadId,
      count: readState.data.unreadCount,
    });
  }
  const [jumped, setJumped] = useState(false);
  // The notification whose versions the side panel shows.
  const [historyId, setHistoryId] = useState<string | null>(null);
  const historyItem = historyId
    ? items.find((item) => item.id === historyId)
    : undefined;
  // The button that opened the panel, given focus back when it closes.
  const historyOpener = useRef<HTMLElement | null>(null);
  const toggleHistory = (id: string) => {
    historyOpener.current = document.activeElement as HTMLElement | null;
    setHistoryId((current) => (current === id ? null : id));
  };
  const firstUnreadId = opened?.firstUnreadId ?? null;
  const rows = useMemo(
    () => buildTimelineRows(items, moved, firstUnreadId),
    [items, moved, firstUnreadId],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  // Set while an older page loads, to keep the rows in view where they were.
  const restore = useRef<{ pages: number; height: number; top: number }>(null);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const pending = restore.current;
    if (pending && (pages?.length ?? 0) > pending.pages) {
      scroller.scrollTop = scroller.scrollHeight - pending.height + pending.top;
      restore.current = null;
    } else if (atEnd.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [rows, pages]);

  // Avatars, icons and fonts settle after the first paint; stay at the end.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current && !restore.current) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [query.isLoading]);

  // The jump goes away once the divider has been in view.
  useEffect(() => {
    const scroller = scrollRef.current;
    const divider = unreadRef.current;
    if (!scroller || !divider || jumped) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setJumped(true);
      },
      { root: scroller },
    );
    observer.observe(divider);
    return () => observer.disconnect();
  }, [rows, jumped]);

  const markRead = useMutation({
    // The activity time on screen: an edit on its way stays unread.
    mutationFn: (newest: { id: string; activityAt: string }) =>
      markNotificationsReadFn({
        data: { notificationId: newest.id, activityAt: newest.activityAt },
      }),
    onSuccess: (state) =>
      queryClient.setQueryData(
        notificationReadStateQueryOptions.queryKey,
        state,
      ),
  });
  const newest = items.at(-1);
  const newestId = newest?.id;
  const newestAt = newest?.activityAt;
  // On a narrow window the versions panel covers the timeline (its CSS
  // takes it out of the flow); nothing behind it is being read.
  const panelRef = useRef<HTMLElement>(null);
  const timelineCovered = () =>
    panelRef.current !== null &&
    getComputedStyle(panelRef.current).position === 'absolute';
  // While the panel covers the timeline, the timeline is inert and focus
  // moves into the panel; it returns to the opening button on close. Side by
  // side, both stay in reach.
  const panelCloseRef = useRef<HTMLButtonElement>(null);
  const [covered, setCovered] = useState(false);
  const historyOpen = historyId !== null;
  useLayoutEffect(() => {
    if (!historyOpen) {
      setCovered(false);
      // Reachable again before the opener inside it takes focus back.
      if (scrollRef.current) scrollRef.current.inert = false;
      const opener = historyOpener.current;
      if (opener?.isConnected) opener.focus();
      historyOpener.current = null;
      return;
    }
    const update = () => setCovered(timelineCovered());
    update();
    const layout = panelRef.current?.parentElement;
    if (!layout) return;
    const observer = new ResizeObserver(update);
    observer.observe(layout);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, [historyOpen]);
  useLayoutEffect(() => {
    if (covered) panelCloseRef.current?.focus();
  }, [covered]);
  // Reading means the newest has been on screen for a moment in a visible tab.
  const readNewest = useEventCallback(() => {
    if (
      !newestId ||
      !newestAt ||
      !atEnd.current ||
      document.visibilityState !== 'visible' ||
      timelineCovered() ||
      markRead.isPending ||
      !readState.data ||
      readState.data.unreadCount === 0
    ) {
      return;
    }
    markRead.mutate({ id: newestId, activityAt: newestAt });
  });
  const unreadNow = readState.data?.unreadCount ?? 0;
  useEffect(() => {
    if (!newestId || unreadNow === 0) return;
    const timer = setTimeout(readNewest, READ_AFTER);
    return () => clearTimeout(timer);
    // Closing the panel shows the timeline again: count from then.
  }, [newestId, newestAt, unreadNow, readNewest, historyId]);
  useEffect(() => {
    document.addEventListener('visibilitychange', readNewest);
    return () => document.removeEventListener('visibilitychange', readNewest);
  }, [readNewest]);

  // Set while a jump waits for the first unread notification to render.
  const pendingJump = useRef(false);
  useLayoutEffect(() => {
    if (!pendingJump.current || !unreadRef.current) return;
    pendingJump.current = false;
    unreadRef.current.scrollIntoView({ block: 'start' });
  }, [rows]);

  const jumpToUnread = async () => {
    atEnd.current = false;
    setJumped(true);
    if (unreadRef.current) {
      unreadRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    // The first unread notification is on an older page: load until it is
    // in, then the effect above scrolls once its divider has rendered.
    pendingJump.current = true;
    const loaded = (data: typeof query.data) =>
      data?.pages.some((page) =>
        page.items.some((item) => item.id === firstUnreadId),
      ) ?? false;
    let found = false;
    try {
      let result = await query.fetchNextPage();
      for (
        let page = 1;
        !loaded(result.data) && result.hasNextPage && page < JUMP_PAGES;
        page += 1
      ) {
        result = await query.fetchNextPage();
      }
      found = loaded(result.data);
    } finally {
      // Not reached within the page budget, or a load failed: give scrolling
      // its pages back, and offer the jump again to go on from here.
      if (!found) {
        pendingJump.current = false;
        setJumped(false);
        loadOlder();
      }
    }
  };

  // Near the top, load the page before. Also checked after every load: a
  // reader already at the top cannot scroll further to ask again, and a load
  // that added no page (a refetch got there first) must not block the next.
  const loadOlder = useEventCallback(() => {
    const scroller = scrollRef.current;
    if (
      !scroller ||
      pendingJump.current ||
      scroller.scrollTop >= NEAR_TOP ||
      !query.hasNextPage ||
      query.isFetching ||
      restore.current
    ) {
      return;
    }
    const pending = {
      pages: pages?.length ?? 0,
      height: scroller.scrollHeight,
      top: scroller.scrollTop,
    };
    restore.current = pending;
    void query.fetchNextPage().finally(() => {
      if (restore.current === pending) {
        const loaded =
          queryClient.getQueryData(notificationTimelineQueryOptions.queryKey)
            ?.pages.length ?? 0;
        if (loaded <= pending.pages) restore.current = null;
      }
    });
  });
  useEffect(() => {
    loadOlder();
  }, [pages, query.isFetching, loadOlder]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const wasAtEnd = atEnd.current;
    atEnd.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
      AT_END;
    if (atEnd.current && !wasAtEnd) readNewest();
    loadOlder();
  };

  if (query.isLoading) {
    return (
      <Center className={classes.scroll}>
        <Loader />
      </Center>
    );
  }
  if (items.length === 0) {
    return (
      <div className={classes.scroll}>
        <EmptyState
          icon={<IconBell size={26} stroke={1.6} />}
          title={t('notifications.timeline.emptyTitle')}
          actions={
            <Button
              component={Link}
              to="/settings/notifications"
              variant="default"
            >
              {t('notifications.timeline.setUp')}
            </Button>
          }
        >
          {t('notifications.timeline.emptyBody')}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={classes.layout}>
      <section
        ref={scrollRef}
        inert={covered}
        className={classes.scroll}
        onScroll={onScroll}
        aria-label={t('notifications.timeline.label')}
      >
        {opened && opened.count > 0 && !jumped ? (
          <div className={classes.jump}>
            <button
              type="button"
              className={classes.jumpButton}
              onClick={() => void jumpToUnread()}
            >
              <IconArrowUp size={14} stroke={2.4} aria-hidden />
              {t('notifications.timeline.unreadJump', { count: opened.count })}
            </button>
          </div>
        ) : null}
        <div ref={contentRef} className={classes.column}>
          <p className={classes.edge}>
            {query.hasNextPage
              ? t('notifications.timeline.loadingOlder')
              : t('notifications.timeline.start')}
          </p>
          {rows.map((row) => {
            switch (row.kind) {
              case 'day':
                return (
                  <div key={row.key} className={classes.day}>
                    {dayLabel(row.date, locale, t)}
                  </div>
                );
              case 'unread':
                return (
                  <div key={row.key} ref={unreadRef} className={classes.unread}>
                    {t('notifications.timeline.unreadDivider', {
                      count: opened?.count ?? 0,
                    })}
                  </div>
                );
              case 'moved':
                return (
                  <div key={row.key} className={classes.moved}>
                    <IconArrowDown size={13} stroke={2.2} aria-hidden />
                    {row.sourceNames.length === 1
                      ? t('notifications.timeline.moved', {
                          source: row.sourceNames[0],
                        })
                      : t('notifications.timeline.movedMany', {
                          count: row.sourceNames.length,
                        })}
                  </div>
                );
              case 'recalled':
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={classes.recalled}
                    aria-pressed={historyId === row.item.id}
                    onClick={() => toggleHistory(row.item.id)}
                  >
                    <IconArrowBackUp size={15} stroke={2} aria-hidden />
                    <span className={classes.recalledText}>
                      {t('notifications.timeline.recalled', {
                        source: row.item.sourceName,
                        title: row.item.title,
                      })}
                    </span>
                    <span className={classes.recalledOpen}>
                      {t('notifications.versions.openRecalled')}
                    </span>
                    <Time iso={row.item.activityAt} />
                  </button>
                );
              case 'quiet':
                return <QuietGroup key={row.key} items={row.items} />;
              case 'item':
                return (
                  <TimelineEntry
                    key={row.key}
                    item={row.item}
                    userId={session?.user.id}
                    historyOpen={historyId === row.item.id}
                    onOpenHistory={() => toggleHistory(row.item.id)}
                  />
                );
            }
          })}
        </div>
      </section>
      {historyItem ? (
        <aside
          ref={panelRef}
          className={classes.panel}
          aria-label={t('notifications.versions.title')}
        >
          <div className={classes.panelHead}>
            <div className={classes.panelTitle}>
              <span className={classes.panelEyebrow}>
                {t('notifications.versions.count', {
                  count: historyItem.earlierVersions + 1,
                })}
              </span>
              <h2 className={classes.panelName}>{historyItem.title}</h2>
              <span className={classes.panelSource}>
                {historyItem.sourceName}
              </span>
            </div>
            <button
              type="button"
              ref={panelCloseRef}
              className={classes.panelClose}
              aria-label={t('notifications.versions.close')}
              onClick={() => setHistoryId(null)}
            >
              <IconX size={14} stroke={2.2} aria-hidden />
            </button>
          </div>
          <div className={classes.panelBody}>
            <NotificationHistory key={historyItem.id} item={historyItem} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function dayLabel(
  iso: string,
  locale: Locale,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const date = dayjs(iso);
  if (date.isSame(dayjs(), 'day')) return t('notifications.timeline.today');
  if (date.isSame(dayjs().subtract(1, 'day'), 'day')) {
    return t('notifications.timeline.yesterday');
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(date.isSame(dayjs(), 'year') ? {} : { year: 'numeric' }),
  }).format(date.toDate());
}

function Time({ iso }: { iso: string }) {
  return (
    <Tooltip label={formatExact(iso)} withArrow>
      <time dateTime={iso} className={classes.time}>
        {dayjs(iso).format('HH:mm')}
      </time>
    </Tooltip>
  );
}

function SourceTile({ item }: { item: TimelineItem }) {
  if (item.sourceType === 'user') {
    return (
      <UserAvatar
        userId={item.sourceId ?? undefined}
        image={null}
        name={item.sourceName}
        size={26}
        radius="xl"
      />
    );
  }
  return (
    <AppGlyph
      name={item.sourceName}
      seed={item.sourceId ?? item.sourceName}
      size="widget"
    />
  );
}

/**
 * One notification: a bubble for a message a person sent, a card for
 * everything else, with its reply form until someone answers and, once its
 * source edited it, what it said before.
 */
function TimelineEntry({
  item,
  userId,
  historyOpen,
  onOpenHistory,
}: {
  item: TimelineItem;
  userId: string | undefined;
  historyOpen: boolean;
  onOpenHistory: () => void;
}) {
  const { t } = useI18n();
  const bubble = item.sourceType === 'user' && !item.reply && !item.url;
  return (
    <article
      className={classes.item}
      aria-label={`${item.sourceName}: ${item.title}`}
    >
      <span className={classes.tile}>
        <SourceTile item={item} />
      </span>
      <div className={classes.main}>
        <div className={classes.meta}>
          <span className={classes.source}>{item.sourceName}</span>
          <Time iso={item.activityAt} />
        </div>
        <div className={bubble ? classes.bubble : classes.card}>
          {item.card?.status ? <CardStatus card={item.card} /> : null}
          <h3 className={classes.title}>{item.title}</h3>
          {item.body ? <p className={classes.body}>{item.body}</p> : null}
          {item.card?.block ? <CardBlock card={item.card} /> : null}
          {item.url ? <NotificationLink url={item.url} /> : null}
          {item.reply ? (
            // A new question is a new form: keyed by round, no draft carries over.
            <Answer key={item.replyRound} item={item} userId={userId} />
          ) : null}
          {item.earlierVersions > 0 ? (
            <button
              type="button"
              className={classes.historyOpen}
              aria-pressed={historyOpen}
              onClick={onOpenHistory}
            >
              <IconHistory size={14} stroke={2.2} aria-hidden />
              {t('notifications.versions.openEdited', {
                count: item.earlierVersions,
              })}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function Answer({
  item,
  userId,
}: {
  item: TimelineItem;
  userId: string | undefined;
}) {
  const { t } = useI18n();
  const { reply, response } = item;
  if (!reply) return null;
  if (!response) {
    return (
      <ReplySection
        notificationId={item.id}
        reply={reply}
        round={item.replyRound}
        response={null}
        recalledAt={item.recalledAt}
      />
    );
  }
  const answer = describeAnswers(reply, response.answers)
    .map((line) => line.value)
    .join(' · ');
  const via = t(`notifications.timeline.via.${response.via}`);
  return (
    <p className={classes.answer}>
      <IconCheck size={15} stroke={2.4} aria-hidden />
      <span>
        {response.respondedBy.userId && response.respondedBy.userId === userId
          ? t('notifications.timeline.answeredYou', { answer, via })
          : t('notifications.timeline.answeredBy', {
              name: response.respondedBy.name,
              answer,
              via,
            })}
      </span>
    </p>
  );
}

function QuietGroup({ items }: { items: TimelineItem[] }): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const last = items.at(-1)!;
  return (
    <div className={classes.item}>
      <span className={classes.quietTile} aria-hidden>
        <IconBellOff size={15} stroke={1.9} />
      </span>
      <div className={classes.quiet}>
        <button
          type="button"
          className={classes.quietToggle}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={classes.quietLabel}>
            {t('notifications.timeline.quiet', { count: items.length })}
          </span>
          <Time iso={last.activityAt} />
          <IconChevronRight
            size={14}
            stroke={2.2}
            className={classes.chevron}
            data-open={open || undefined}
            aria-hidden
          />
        </button>
        {open ? (
          <ul className={classes.quietList}>
            {items.map((item) => (
              <li key={item.id}>
                {/* Opens it in the log: body, link, card and delivery. */}
                <Link
                  to="/notifications/log/$notificationId"
                  params={{ notificationId: item.id }}
                  className={classes.quietLine}
                >
                  <span className={classes.source}>{item.sourceName}</span>
                  <span className={classes.quietTitle}>{item.title}</span>
                  <Time iso={item.activityAt} />
                  <IconChevronRight
                    size={14}
                    stroke={2.2}
                    className={classes.chevron}
                    aria-hidden
                  />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
