import { useQuery } from '@tanstack/react-query';
import {
  Stack,
  router,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
} from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Alert, Linking, RefreshControl, StyleSheet, View } from 'react-native';
import { MobileError, notificationUrlAction } from '../../src/core';
import { openSurfaceLink } from '../../src/state/deep-links';
import { allowDevelopmentLoopback, useSession } from '../../src/state/session';
import { useDeleteNotification } from '../../src/state/use-delete-notification';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { Button } from '../../src/ui/button';
import { glyphs } from '../../src/ui/glyph.types';
import {
  Busy,
  Card,
  EmptyState,
  Notice,
  errorText,
} from '../../src/ui/primitives';
import {
  DeliveryStatusTag,
  NotificationChangeTag,
  NotificationStatusTag,
  notificationTime,
} from '../../src/ui/notification-status';
import { ScrollScreen, SectionLabel } from '../../src/ui/screen';
import { Text, type } from '../../src/ui/text';
import { palette as c } from '../../src/ui/theme';

const destinationLabels: Record<string, string> = {
  device: 'Device',
  webhook: 'Webhook',
  app: 'App',
};

export default function NotificationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const { api, origin } = useSession();
  const query = useQuery({
    queryKey: [origin, 'notification', id],
    queryFn: ({ signal }) => api!.notification(id, signal),
    enabled: Boolean(api),
  });
  const pull = usePullToRefresh(useIsFocused(), () => query.refetch());
  const { confirmDelete, isPending: deleting } = useDeleteNotification({
    onDeleted: () => {
      // A slow response must not pop a screen the user opened since.
      if (!navigation.isFocused()) return;
      if (router.canGoBack()) router.back();
      else router.replace('/notifications');
    },
  });
  const data = query.data;
  // Deleted (here, elsewhere, or expired): never show a cached copy.
  if (query.error instanceof MobileError && query.error.status === 404)
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.paper }}>
        <EmptyState
          title="Notification not found"
          detail="It was deleted or has expired from history on this instance."
          action={{
            label: 'All notifications',
            onPress: () => router.replace('/notifications'),
          }}
        />
      </View>
    );
  if (query.error && !data)
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.paper }}>
        <Notice
          tone="danger"
          title="Couldn’t load this notification"
          detail={errorText(query.error)}
          action={{ label: 'Try again', onPress: () => void query.refetch() }}
        />
      </View>
    );
  if (!data) return <Busy label="Loading notification" />;
  return (
    <ScrollScreen
      nested
      eyebrow={`${data.sourceName} · ${data.kindName}`}
      title={data.title}
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
          icon={glyphs.trash}
          disabled={deleting}
          onPress={() => confirmDelete(data)}
        >
          Delete notification
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View style={{ paddingHorizontal: 16, gap: 14 }}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <NotificationStatusTag status={data.status} />
          <NotificationChangeTag
            editedAt={data.editedAt}
            recalledAt={data.recalledAt}
          />
          <Text style={type.meta}>{notificationTime(data.occurredAt)}</Text>
        </View>
        {data.recalledAt ? (
          <Text style={type.small}>
            The sender recalled this notification on{' '}
            {notificationTime(data.recalledAt)}. It was removed from phones and
            is kept here for history.
          </Text>
        ) : data.editedAt ? (
          <Text style={type.small}>
            The sender edited this notification on{' '}
            {notificationTime(data.editedAt)}.
          </Text>
        ) : null}
        {data.body ? (
          <Card>
            <Text selectable style={type.body}>
              {data.body}
            </Text>
          </Card>
        ) : null}
        {data.url ? (
          <Button
            variant="secondary"
            glyph="browser"
            label="Open link"
            fullWidth
            onPress={() => {
              // Hatch pages, by address or deep link, open here; other web
              // pages in the browser, and any other scheme in its own app.
              const action = notificationUrlAction(data.url!, origin!, {
                allowDevelopmentLoopback,
              });
              if (action.open === 'page') openSurfaceLink(action.link);
              else if (action.open === 'none')
                Alert.alert(
                  'Couldn’t open link',
                  'This version of Hatch can’t open this page. Update the app and try again.',
                );
              else if (/^https?:/i.test(action.url))
                void WebBrowser.openBrowserAsync(action.url).catch(
                  (error: unknown) =>
                    Alert.alert('Couldn’t open link', errorText(error)),
                );
              else
                void Linking.openURL(action.url).catch(() =>
                  Alert.alert(
                    'Couldn’t open link',
                    `No app on this device opens “${action.url.split(':')[0]}” links.`,
                  ),
                );
            }}
          />
        ) : null}
        <SectionLabel count={data.deliveries.length}>Deliveries</SectionLabel>
        {data.deliveries.length === 0 ? (
          <Text style={type.small}>
            No route sent this notification anywhere. It is kept in history
            only.
          </Text>
        ) : (
          <Card style={{ gap: 0, paddingVertical: 4 }}>
            {data.deliveries.map((delivery, index) => (
              <View
                key={delivery.id}
                style={[
                  styles.delivery,
                  index > 0 && {
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: c.rule,
                  },
                ]}
              >
                <View style={styles.header}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={type.heading}>{delivery.destinationName}</Text>
                    <Text style={type.meta}>
                      {destinationLabels[delivery.destinationType] ??
                        delivery.destinationType}
                      {delivery.attempts > 1
                        ? ` · ${delivery.attempts} attempts`
                        : ''}
                    </Text>
                  </View>
                  <DeliveryStatusTag status={delivery.status} />
                </View>
                {delivery.result ? (
                  <Text selectable style={type.small}>
                    {delivery.result}
                  </Text>
                ) : null}
                {delivery.lastError ? (
                  <Text selectable style={[type.small, { color: c.danger }]}>
                    {delivery.lastError}
                  </Text>
                ) : null}
              </View>
            ))}
          </Card>
        )}
      </View>
    </ScrollScreen>
  );
}

const styles = StyleSheet.create({
  delivery: { paddingVertical: 12, gap: 6 },
  header: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
