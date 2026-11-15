import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, Stack, router, useIsFocused } from 'expo-router';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSession } from '../../src/state/session';
import { useDeleteNotification } from '../../src/state/use-delete-notification';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { Button } from '../../src/ui/button';
import { Reflow } from '../../src/ui/columns';
import { glyphs } from '../../src/ui/glyph.types';
import { Busy, EmptyState, Notice, errorText } from '../../src/ui/primitives';
import {
  NotificationChangeTag,
  NotificationPriorityTag,
  NotificationReplyTag,
  NotificationStatusTag,
  notificationTime,
} from '../../src/ui/notification-status';
import { Group } from '../../src/ui/rows';
import { ScrollScreen } from '../../src/ui/screen';
import { Text, type } from '../../src/ui/text';
import { palette as c } from '../../src/ui/theme';

export default function NotificationsScreen() {
  const { api, origin } = useSession();
  const query = useInfiniteQuery({
    queryKey: [origin, 'notifications'],
    queryFn: ({ pageParam, signal }) =>
      api!.notifications(pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api),
  });
  const pull = usePullToRefresh(useIsFocused(), () => query.refetch());
  const { confirmDelete } = useDeleteNotification();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const host = origin?.replace(/^https?:\/\//, '') ?? '';
  return (
    <ScrollScreen
      nested
      eyebrow={host}
      title="Notifications"
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={c.moss}
        />
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
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
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
            title="No notifications yet"
            detail="Apps and channels on this instance send notifications here. Routing is set up in Hatch on the web."
          />
        ) : null}
        {items.length > 0 ? (
          <Reflow
            items={items}
            render={(column) => (
              <Group>
                {column.map((item) => (
                  // Touch and hold for the native context menu.
                  <Link
                    key={item.id}
                    href={`/notifications/${item.id}`}
                    asChild
                  >
                    <Link.Trigger>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${item.title}, from ${item.sourceName}`}
                        accessibilityHint="Touch and hold for more actions"
                      >
                        {/* Link's Slot cannot merge a style function, so the
                            pressed look lives on an inner view. */}
                        {({ pressed }) => (
                          <View
                            style={[
                              styles.row,
                              pressed && { backgroundColor: c.limeSoft },
                            ]}
                          >
                            <View style={styles.header}>
                              <Text
                                style={[type.meta, styles.grow]}
                                numberOfLines={1}
                              >
                                {item.sourceName} · {item.kindName}
                              </Text>
                              <Text style={type.meta}>
                                {notificationTime(item.occurredAt)}
                              </Text>
                            </View>
                            <Text style={type.heading}>{item.title}</Text>
                            {item.body ? (
                              <Text style={type.small} numberOfLines={3}>
                                {item.body}
                              </Text>
                            ) : null}
                            <View style={styles.tags}>
                              <NotificationStatusTag status={item.status} />
                              <NotificationPriorityTag
                                priority={item.priority}
                              />
                              <NotificationChangeTag
                                editedAt={item.editedAt}
                                recalledAt={item.recalledAt}
                              />
                              <NotificationReplyTag
                                hasReply={item.reply !== null}
                                respondedAt={item.respondedAt}
                                recalledAt={item.recalledAt}
                              />
                            </View>
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
                ))}
              </Group>
            )}
          />
        ) : null}
        {query.hasNextPage ? (
          <Button
            variant="secondary"
            fullWidth
            label={query.isFetchingNextPage ? 'Loading…' : 'Load older'}
            busy={query.isFetchingNextPage}
            onPress={() => void query.fetchNextPage()}
          />
        ) : null}
      </View>
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  header: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flex: 1 },
  tags: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
});
