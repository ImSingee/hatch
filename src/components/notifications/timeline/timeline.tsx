import { Button, Center, Loader, Tooltip } from '@mantine/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconArrowBackUp,
  IconArrowDown,
  IconBell,
  IconBellOff,
  IconCheck,
  IconChevronRight,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import {
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
import { formatExact } from '~lib/format';
import { notificationTimelineQueryOptions } from '~queries/notifications';
import { NotificationLink } from '../notification-detail';
import { ReplySection } from '../reply-section';
import {
  buildTimelineRows,
  nextMovedMarkers,
  type MovedMarker,
  type TimelineItem,
} from './timeline-rows';
import classes from './timeline.module.css';

/** How close to the end, in px, still counts as reading the newest. */
const AT_END = 80;
/** How close to the top, in px, loads the next older page. */
const NEAR_TOP = 240;

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
 * loads older pages when they scroll up.
 */
export function NotificationTimeline() {
  const { t, locale } = useI18n();
  const { data: session } = authClient.useSession();
  const query = useInfiniteQuery(notificationTimelineQueryOptions);
  const pages = query.data?.pages;
  const items = useMemo(
    () => (pages ?? []).flatMap((page) => page.items).reverse(),
    [pages],
  );
  const moved = useMovedMarkers(items);
  const rows = useMemo(() => buildTimelineRows(items, moved), [items, moved]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    atEnd.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
      AT_END;
    if (
      scroller.scrollTop < NEAR_TOP &&
      query.hasNextPage &&
      !query.isFetchingNextPage &&
      !restore.current
    ) {
      restore.current = {
        pages: pages?.length ?? 0,
        height: scroller.scrollHeight,
        top: scroller.scrollTop,
      };
      void query.fetchNextPage();
    }
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
    <section
      ref={scrollRef}
      className={classes.scroll}
      onScroll={onScroll}
      aria-label={t('notifications.timeline.label')}
    >
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
                <p key={row.key} className={classes.recalled}>
                  <IconArrowBackUp size={15} stroke={2} aria-hidden />
                  <span className={classes.recalledText}>
                    {t('notifications.timeline.recalled', {
                      source: row.item.sourceName,
                      title: row.item.title,
                    })}
                  </span>
                  <Time iso={row.item.activityAt} />
                </p>
              );
            case 'quiet':
              return <QuietGroup key={row.key} items={row.items} />;
            case 'item':
              return (
                <TimelineEntry
                  key={row.key}
                  item={row.item}
                  userId={session?.user.id}
                />
              );
          }
        })}
      </div>
    </section>
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
      icon={item.sourceType === 'app'}
    />
  );
}

/**
 * One notification: a bubble for a message a person sent, a card for
 * everything else, with its reply form until someone answers.
 */
function TimelineEntry({
  item,
  userId,
}: {
  item: TimelineItem;
  userId: string | undefined;
}) {
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
          <h3 className={classes.title}>{item.title}</h3>
          {item.body ? <p className={classes.body}>{item.body}</p> : null}
          {item.url ? <NotificationLink url={item.url} /> : null}
          {item.reply ? <Answer item={item} userId={userId} /> : null}
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
              <li key={item.id} className={classes.quietLine}>
                <span className={classes.source}>{item.sourceName}</span>
                <span className={classes.quietTitle}>{item.title}</span>
                <Time iso={item.activityAt} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
