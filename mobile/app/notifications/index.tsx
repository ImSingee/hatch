import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { Link, Stack, router, useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
} from 'react-native';
import {
  cardHead,
  notificationHeadline,
} from '../../../packages/hatch-platform-api/notification-content';
import {
  buildTimelineRows,
  nextMovedMarkers,
  type MovedMarker,
} from '../../../packages/hatch-platform-api/notification-timeline';
import type { NotificationSummary } from '../../src/core/types';
import {
  readStateKey,
  useNotificationReadState,
} from '../../src/state/notification-read-state';
import { useSession } from '../../src/state/session';
import { useDeleteNotification } from '../../src/state/use-delete-notification';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { useRespondToNotification } from '../../src/state/use-respond-notification';
import { Button } from '../../src/ui/button';
import { Glyph } from '../../src/ui/glyph';
import { glyphs } from '../../src/ui/glyph.types';
import {
  NotificationContent,
  asksInline,
} from '../../src/ui/notification-card';
import { cardIconGlyph } from '../../src/ui/notification-content-model';
import { notificationTime } from '../../src/ui/notification-status';
import {
  Busy,
  EmptyState,
  Notice,
  Tag,
  errorText,
} from '../../src/ui/primitives';
import { AnswerLine } from '../../src/ui/reply-card';
import { ScrollScreen } from '../../src/ui/screen';
import { Text, useType } from '../../src/ui/text';
import { pill, tileFor, weights } from '../../src/ui/theme';
import {
  themedStyles,
  useAccent,
  usePalette,
  useTheme,
} from '../../src/ui/theme-context';

/** How close to the end, in points, still counts as reading the newest. */
const AT_END = 80;
/** How long the newest must stay in view before it counts as read, in ms. */
const READ_AFTER = 600;
/** Older pages the unread jump loads before handing back to scrolling. */
const JUMP_PAGES = 20;

/** Where notifications were before their source moved them, while open. */
function useMovedMarkers(items: NotificationSummary[]): MovedMarker[] {
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

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * Every notification as one stream, oldest at the top, the same as on the
 * web: it opens at the newest and follows new ones while you are at the end.
 * What was unread when it opened is marked, with a jump back to it, and
 * reaching the end marks everything read here and on the web.
 */
export default function NotificationsScreen() {
  const { api, origin } = useSession();
  const accent = useAccent();
  const c = usePalette();
  const type = useType();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const focused = useIsFocused();
  const query = useInfiniteQuery({
    queryKey: [origin, 'notifications'],
    queryFn: ({ pageParam, signal }) =>
      api!.notifications(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
  });
  const readState = useNotificationReadState();
  const pull = usePullToRefresh(focused, () =>
    Promise.all([query.refetch(), readState.refetch()]),
  );
  const { confirmDelete } = useDeleteNotification();
  const pages = query.data?.pages;
  const items = useMemo(
    () => (pages ?? []).flatMap((page) => page.items).reverse(),
    [pages],
  );
  const moved = useMovedMarkers(items);

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
  const firstUnreadId = opened?.firstUnreadId ?? null;
  const rows = useMemo(
    () => buildTimelineRows(items, moved, firstUnreadId),
    [items, moved, firstUnreadId],
  );
  const [openQuiet, setOpenQuiet] = useState<Record<string, boolean>>({});

  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const atEnd = useRef(true);
  const listTop = useRef(0);
  const unreadTop = useRef<number | null>(null);
  // The latest scroll position and content height, to hold the view still
  // while older pages arrive above it.
  const offset = useRef(0);
  const contentHeight = useRef(0);
  const restore = useRef<{ pages: number; height: number; y: number }>(null);
  // Set while a jump waits for the first unread notification to load.
  const pendingJump = useRef(false);

  const scrollToUnread = () => {
    if (unreadTop.current === null) return false;
    scroll.current?.scrollTo({
      y: Math.max(0, listTop.current + unreadTop.current - 16),
      animated: true,
    });
    return true;
  };

  const loadEarlier = () => {
    atEnd.current = false;
    restore.current = {
      pages: pages?.length ?? 0,
      height: contentHeight.current,
      y: offset.current,
    };
    return query.fetchNextPage();
  };

  const markRead = useMutation({
    // The activity time on screen: an edit on its way stays unread.
    mutationFn: (newest: { id: string; activityAt: string }) =>
      api!.markNotificationsRead(newest.id, newest.activityAt),
    onSuccess: (state) => queryClient.setQueryData(readStateKey(origin), state),
  });
  const { mutate: mark, isPending: marking } = markRead;
  const newest = items.at(-1);
  const newestId = newest?.id;
  const newestAt = newest?.activityAt;
  const unread = readState.data?.unreadCount ?? 0;
  useEffect(() => {
    if (!focused || !newestId || !newestAt || unread === 0 || marking) return;
    const timer = setTimeout(() => {
      if (atEnd.current) mark({ id: newestId, activityAt: newestAt });
    }, READ_AFTER);
    return () => clearTimeout(timer);
  }, [focused, newestId, newestAt, unread, marking, mark]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    offset.current = contentOffset.y;
    const bottom = contentOffset.y + layoutMeasurement.height;
    atEnd.current = bottom >= contentSize.height - AT_END;
    if (
      !jumped &&
      unreadTop.current !== null &&
      contentOffset.y <= listTop.current + unreadTop.current
    ) {
      setJumped(true);
    }
    if (atEnd.current && newestId && newestAt && unread > 0 && !marking) {
      mark({ id: newestId, activityAt: newestAt });
    }
  };

  const jumpToUnread = async () => {
    setJumped(true);
    atEnd.current = false;
    if (scrollToUnread()) return;
    // The first unread notification is on an older page: load until it is.
    pendingJump.current = true;
    const reached = (data: typeof query.data) =>
      data?.pages.some((p) =>
        p.items.some((item) => item.id === firstUnreadId),
      ) ?? false;
    let found = false;
    try {
      let result = await loadEarlier();
      for (
        let page = 1;
        !reached(result.data) && result.hasNextPage && page < JUMP_PAGES;
        page += 1
      ) {
        result = await loadEarlier();
      }
      found = reached(result.data);
    } finally {
      // Not reached within the page budget, or a load failed: drop the
      // pending jump so a later load cannot fire it, and offer it again to
      // go on from here.
      if (!found) {
        pendingJump.current = false;
        setJumped(false);
      }
    }
  };

  const host = origin?.replace(/^https?:\/\//, '') ?? '';
  const showJump = Boolean(opened && opened.count > 0 && !jumped);
  return (
    <ScrollScreen
      readable
      nested
      eyebrow={host}
      title="Notifications"
      scrollRef={scroll}
      onScroll={onScroll}
      scrollEventThrottle={64}
      onContentSizeChange={(_width, height) => {
        const previous = contentHeight.current;
        contentHeight.current = height;
        const pending = restore.current;
        if (pending && (pages?.length ?? 0) > pending.pages) {
          // Older notifications arrived above: keep the same ones in view.
          restore.current = null;
          scroll.current?.scrollTo({
            y: pending.y + (height - pending.height),
            animated: false,
          });
        } else if (atEnd.current && height !== previous) {
          scroll.current?.scrollToEnd({ animated: false });
        }
      }}
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={accent.fill}
        />
      }
      overlay={
        showJump ? (
          <View style={styles.jumpWrap} pointerEvents="box-none">
            <Pressable
              accessibilityRole="button"
              onPress={() => void jumpToUnread()}
              style={({ pressed }) => [
                styles.jump,
                pressed && { backgroundColor: c.hover },
              ]}
            >
              <Glyph name="up" size={13} color={accent.fill} />
              <Text style={[type.small, { color: c.ink }]}>
                {opened!.count} unread · Jump to where you left off
              </Text>
            </Pressable>
          </View>
        ) : null
      }
    >
      {/* A native bar item so iPhone Duo can move it to the vertical bar. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={glyphs.settings}
          onPress={() => router.push('/notifications/settings')}
        >
          Notification settings
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View
        style={styles.column}
        onLayout={(event) => {
          listTop.current = event.nativeEvent.layout.y;
        }}
      >
        {query.error ? (
          <Notice
            tone="danger"
            title="Couldn’t load notifications"
            detail={errorText(query.error)}
            action={{ label: 'Try again', onPress: () => void query.refetch() }}
          />
        ) : null}
        {!query.data && !query.error ? (
          <Busy label="Loading notifications" />
        ) : null}
        {query.data && items.length === 0 ? (
          <EmptyState
            glyph="bell"
            title="No notifications yet"
            detail="What your Apps, Channels and the Agent send shows up here and on the web. Routing is set up in Hatch on the web."
          />
        ) : null}
        {query.hasNextPage ? (
          <Button
            variant="secondary"
            fullWidth
            label={query.isFetchingNextPage ? 'Loading…' : 'Load earlier'}
            busy={query.isFetchingNextPage}
            onPress={() => void loadEarlier()}
          />
        ) : null}
        {rows.map((row) => {
          switch (row.kind) {
            case 'day':
              return (
                <View key={row.key} style={styles.divider}>
                  <View style={styles.rule} />
                  <Text style={type.caption}>{dayLabel(row.date)}</Text>
                  <View style={styles.rule} />
                </View>
              );
            case 'unread':
              return (
                <View
                  key={row.key}
                  style={styles.divider}
                  onLayout={(event) => {
                    unreadTop.current = event.nativeEvent.layout.y;
                    if (pendingJump.current) {
                      pendingJump.current = false;
                      // After the restore, which keeps older pages above.
                      requestAnimationFrame(() => scrollToUnread());
                    }
                  }}
                >
                  <View
                    style={[styles.rule, { backgroundColor: accent.fill }]}
                  />
                  <Text style={[type.caption, { color: accent.ink }]}>
                    {opened?.count ?? 0} unread below
                  </Text>
                  <View
                    style={[styles.rule, { backgroundColor: accent.fill }]}
                  />
                </View>
              );
            case 'moved':
              return (
                <View key={row.key} style={styles.moved}>
                  <Glyph name="down" size={12} color={c.inkSoft} />
                  <Text style={type.caption}>
                    {row.sourceNames.length === 1
                      ? `${row.sourceNames[0]} has an update, moved below`
                      : `${row.sourceNames.length} notifications have updates, moved below`}
                  </Text>
                </View>
              );
            case 'recalled':
              return (
                <Link
                  key={row.key}
                  href={`/notifications/history/${row.item.id}`}
                  asChild
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityHint="Shows what it said before it was recalled"
                    style={({ pressed }) => [
                      styles.recalled,
                      pressed && { backgroundColor: c.hover },
                    ]}
                  >
                    <Text style={[type.small, { flex: 1 }]}>
                      {row.item.sourceName} recalled “
                      {notificationHeadline(row.item)}”
                    </Text>
                    <Text
                      style={[
                        type.caption,
                        { color: accent.ink, fontWeight: weights.heading },
                      ]}
                    >
                      View original
                    </Text>
                  </Pressable>
                </Link>
              );
            case 'quiet': {
              const open = Boolean(openQuiet[row.key]);
              return (
                <View key={row.key} style={styles.quiet}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    onPress={() =>
                      setOpenQuiet((current) => ({
                        ...current,
                        [row.key]: !open,
                      }))
                    }
                    style={({ pressed }) => [
                      styles.quietToggle,
                      pressed && { backgroundColor: c.hover },
                    ]}
                  >
                    <Glyph name="bell" size={14} color={c.inkSoft} />
                    <Text style={[type.small, { flex: 1, color: c.ink }]}>
                      {row.items.length} quiet{' '}
                      {row.items.length === 1
                        ? 'notification'
                        : 'notifications'}
                    </Text>
                    <Text style={type.caption}>
                      {notificationTime(row.items.at(-1)!.activityAt)}
                    </Text>
                  </Pressable>
                  {/* Each opens the notification, with its body, link and
                      delete; low priority ones may never reach the
                      Notification Center. */}
                  {open
                    ? row.items.map((item) => (
                        <Link
                          key={item.id}
                          href={`/notifications/${item.id}`}
                          asChild
                        >
                          <Link.Trigger>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`${notificationHeadline(item)}, from ${item.sourceName}`}
                              accessibilityHint="Touch and hold for more actions"
                            >
                              {/* Styled inside: the link trigger replaces the
                                  Pressable's own style. */}
                              {({ pressed }) => (
                                <View
                                  style={[
                                    styles.quietLine,
                                    pressed && { backgroundColor: c.hover },
                                  ]}
                                >
                                  <Text
                                    style={[type.caption, { color: c.ink }]}
                                  >
                                    {item.sourceName}
                                  </Text>
                                  <Text
                                    style={[type.small, { flex: 1 }]}
                                    numberOfLines={1}
                                  >
                                    {notificationHeadline(item)}
                                  </Text>
                                  <Glyph
                                    name="chevron"
                                    size={10}
                                    color={c.inkSoft}
                                  />
                                </View>
                              )}
                            </Pressable>
                          </Link.Trigger>
                          <Link.Menu>
                            <Link.MenuAction
                              icon="trash"
                              destructive
                              onPress={() => confirmDelete(item)}
                            >
                              Delete
                            </Link.MenuAction>
                          </Link.Menu>
                        </Link>
                      ))
                    : null}
                </View>
              );
            }
            case 'item':
              return (
                <TimelineEntry
                  key={row.key}
                  item={row.item}
                  onDelete={() => confirmDelete(row.item)}
                />
              );
          }
        })}
      </View>
    </ScrollScreen>
  );
}

/** One notification: a bubble for a person's message, else a card. */
function TimelineEntry({
  item,
  onDelete,
}: {
  item: NotificationSummary;
  onDelete: () => void;
}) {
  const accent = useAccent();
  const c = usePalette();
  const { radii } = useTheme();
  const type = useType();
  const styles = useStyles();
  const respond = useRespondToNotification(item.id);
  const bubble =
    item.format === 'text' &&
    item.sourceType === 'user' &&
    !item.reply &&
    !item.url;
  const inline = asksInline(item.content, item.reply);
  const awaiting = Boolean(item.reply && !item.response && !item.recalledAt);
  const icon = cardIconGlyph(cardHead(item.content).icon);
  return (
    <View style={styles.entry}>
      {icon ? (
        // A card's icon takes the place of the source tile.
        <View
          style={[
            styles.tile,
            { backgroundColor: c.ink, borderRadius: radii.sm },
          ]}
        >
          <Glyph name={icon} size={14} color={c.card} />
        </View>
      ) : (
        <View
          style={[
            styles.tile,
            {
              backgroundColor: tileFor(item.sourceId ?? item.sourceName),
              borderRadius: item.sourceType === 'user' ? pill : radii.sm,
            },
          ]}
        >
          <Text style={styles.tileText}>
            {Array.from(item.sourceName.trim())[0]?.toUpperCase() ?? '?'}
          </Text>
        </View>
      )}
      <View style={styles.main}>
        <View style={styles.meta}>
          <Text
            style={[type.caption, { flexShrink: 1, color: c.ink }]}
            numberOfLines={1}
          >
            {/* A kind named like its source is said once. */}
            {item.kindName === item.sourceName
              ? item.sourceName
              : `${item.sourceName} · ${item.kindName}`}
          </Text>
          <Text style={type.caption}>{notificationTime(item.activityAt)}</Text>
        </View>
        {/* Touch and hold for the native context menu. */}
        <Link href={`/notifications/${item.id}`} asChild>
          <Link.Trigger>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${notificationHeadline(item)}, from ${item.sourceName}`}
              accessibilityHint={
                awaiting && !inline
                  ? 'Opens the question to answer'
                  : 'Touch and hold for more actions'
              }
            >
              {({ pressed }) => (
                <View
                  style={[
                    bubble ? styles.bubble : styles.card,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  {item.format !== 'text' && item.content ? (
                    <NotificationContent
                      // A new question is a new form: no draft carries over.
                      key={item.replyRound}
                      content={item.content}
                      reply={item.reply}
                      answer={item.response}
                      editedAt={item.editedAt}
                      respond={
                        awaiting && inline
                          ? {
                              busy: respond.isPending,
                              onSubmit: (answers) =>
                                respond.mutate({
                                  round: item.replyRound,
                                  answers,
                                }),
                            }
                          : null
                      }
                    />
                  ) : (
                    <>
                      <Text style={bubble ? type.body : type.heading}>
                        {notificationHeadline(item)}
                      </Text>
                      {/* Text, or the plain text of content this build
                          cannot read. */}
                      {(item.body ?? item.text) ? (
                        <Text style={type.small} numberOfLines={4}>
                          {item.body ?? item.text}
                        </Text>
                      ) : null}
                    </>
                  )}
                  {awaiting && !inline ? (
                    <Tag label="Answer" tone="accent" glyph="question" />
                  ) : item.reply && item.response ? (
                    <AnswerLine reply={item.reply} answer={item.response} />
                  ) : null}
                </View>
              )}
            </Pressable>
          </Link.Trigger>
          <Link.Menu>
            <Link.MenuAction icon="trash" destructive onPress={onDelete}>
              Delete
            </Link.MenuAction>
          </Link.Menu>
        </Link>
        {item.earlierVersions > 0 ? (
          <Link href={`/notifications/history/${item.id}`} asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Shows every version of this notification"
              style={({ pressed }) => [
                styles.historyOpen,
                pressed && { backgroundColor: accent.ground },
              ]}
            >
              <Glyph name="edit" size={13} color={accent.ink} />
              <Text
                style={[
                  type.caption,
                  { color: accent.ink, fontWeight: weights.heading },
                ]}
              >
                Edited {item.earlierVersions}{' '}
                {item.earlierVersions === 1 ? 'time' : 'times'} · View history
              </Text>
            </Pressable>
          </Link>
        ) : null}
      </View>
    </View>
  );
}

const useStyles = themedStyles((t) =>
  StyleSheet.create({
    column: { paddingHorizontal: 16, gap: 16 },
    divider: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    rule: {
      flex: 1,
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.palette.hairline,
    },
    moved: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginLeft: 38,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: pill,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: t.palette.input,
    },
    recalled: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 44,
      marginLeft: 26,
      paddingHorizontal: 12,
      borderRadius: t.radii.md,
    },
    historyOpen: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 10,
      marginLeft: -10,
      borderRadius: t.radii.md,
    },
    quiet: {
      borderRadius: t.radii.lg,
      backgroundColor: t.palette.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.palette.hairline,
      overflow: 'hidden',
    },
    quietToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 14,
    },
    quietLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 44,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.palette.hairline,
    },
    entry: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    tile: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 1,
    },
    tileText: {
      color: t.palette.onTile,
      fontSize: 13,
      fontWeight: weights.heading,
    },
    main: { flex: 1, minWidth: 0, gap: 5 },
    meta: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    card: {
      gap: 10,
      padding: 14,
      borderRadius: t.radii.lg,
      backgroundColor: t.palette.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.palette.hairline,
    },
    bubble: {
      alignSelf: 'flex-start',
      gap: 2,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderTopLeftRadius: t.radii.xl,
      borderTopRightRadius: t.radii.xl,
      borderBottomRightRadius: t.radii.xl,
      borderBottomLeftRadius: t.radii.xs,
      backgroundColor: t.palette.muted,
    },
    jumpWrap: {
      position: 'absolute',
      top: 12,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    jump: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: pill,
      backgroundColor: t.palette.card,
      // The dock's float: the same offset, blur and ink as before, and a
      // dark theme's own shadow ink.
      boxShadow: t.shadows.dock,
    },
  }),
);
