import { useQuery } from '@tanstack/react-query';
import type { ReplyAnswers } from '@hatch/platform-api';
import {
  Stack,
  router,
  useIsFocused,
  useLocalSearchParams,
  useNavigation,
} from 'expo-router';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { notificationHeadline } from '../../../packages/hatch-platform-api/notification-content';
import { contentToMarkup } from '../../../packages/hatch-platform-api/notification-content-text';
import { MobileError } from '../../src/core';
import { useSession } from '../../src/state/session';
import {
  useDeleteNotification,
  useNotificationDeleted,
} from '../../src/state/use-delete-notification';
import { useOpenNotificationUrl } from '../../src/state/use-open-notification-url';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { useRespondToNotification } from '../../src/state/use-respond-notification';
import { Button } from '../../src/ui/button';
import { glyphs } from '../../src/ui/glyph.types';
import {
  NotificationContent,
  asksInline,
} from '../../src/ui/notification-card';
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
  NotificationPriorityTag,
  NotificationReplyTag,
  NotificationStatusTag,
  notificationTime,
} from '../../src/ui/notification-status';
import { AnswerCard, AnswerLine, ReplyFormCard } from '../../src/ui/reply-card';
import { ScrollScreen, SectionLabel } from '../../src/ui/screen';
import { Text, type } from '../../src/ui/text';
import { useAccent } from '../../src/ui/accent';
import { palette as c, radii } from '../../src/ui/theme';

const destinationLabels: Record<string, string> = {
  device: 'Device',
  webhook: 'Webhook',
  app: 'App',
  agent: 'Agent chat',
};

export default function NotificationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const { api, origin } = useSession();
  const accent = useAccent();
  const deleted = useNotificationDeleted(id);
  const query = useQuery({
    queryKey: [origin, 'notification', id],
    queryFn: ({ signal }) => api!.notification(id, signal),
    enabled: Boolean(api) && !deleted,
  });
  const pull = usePullToRefresh(useIsFocused(), () => query.refetch());
  const respond = useRespondToNotification(id);
  const openUrl = useOpenNotificationUrl();
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
  if (
    deleted ||
    (query.error instanceof MobileError && query.error.status === 404)
  )
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.ground }}>
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
      <View style={{ flex: 1, padding: 16, backgroundColor: c.ground }}>
        <Notice
          tone="danger"
          title="Couldn’t load this notification"
          detail={errorText(query.error)}
          action={{ label: 'Try again', onPress: () => void query.refetch() }}
        />
      </View>
    );
  if (!data) return <Busy label="Loading notification" />;
  const inline = asksInline(data.content, data.reply);
  const submit = (answers: ReplyAnswers) =>
    respond.mutate({ round: data.replyRound, answers });
  // What the sender wrote: the Markdown, or the card's canonical markup.
  const source =
    data.format === 'markdown'
      ? data.markdown
      : data.format === 'card' && data.content
        ? contentToMarkup(data.content)
        : null;
  return (
    <ScrollScreen
      readable
      nested
      eyebrow={`${data.sourceName} · ${data.kindName}`}
      title={notificationHeadline(data)}
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={accent.fill}
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
          <NotificationPriorityTag priority={data.priority} />
          <NotificationChangeTag
            editedAt={data.editedAt}
            recalledAt={data.recalledAt}
          />
          <NotificationReplyTag
            hasReply={data.reply !== null}
            respondedAt={data.respondedAt}
            recalledAt={data.recalledAt}
          />
          <Text style={type.caption}>{notificationTime(data.occurredAt)}</Text>
        </View>
        {data.priority === -2 ? (
          <Text style={type.small}>
            Lowest priority: this notification is kept here and was not pushed
            to phones.
          </Text>
        ) : null}
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
        {data.earlierVersions > 0 || data.recalledAt ? (
          <Button
            label={
              data.recalledAt ? 'View every version' : 'View earlier versions'
            }
            variant="secondary"
            size="small"
            onPress={() => router.push(`/notifications/history/${id}`)}
          />
        ) : null}
        {data.format !== 'text' && data.content ? (
          <Card style={{ gap: 12 }}>
            <NotificationContent
              key={data.replyRound}
              selectable
              content={data.content}
              reply={data.reply}
              answer={data.response}
              editedAt={data.editedAt}
              respond={
                inline && !data.recalledAt
                  ? { busy: respond.isPending, onSubmit: submit }
                  : null
              }
            />
            {inline && data.reply && data.response ? (
              <AnswerLine reply={data.reply} answer={data.response} />
            ) : null}
          </Card>
        ) : (data.body ?? data.text) ? (
          <Card>
            <Text selectable style={type.body}>
              {data.body ?? data.text}
            </Text>
          </Card>
        ) : null}
        {inline ? null : data.reply && data.response ? (
          <AnswerCard reply={data.reply} answer={data.response} />
        ) : data.reply && !data.recalledAt ? (
          <ReplyFormCard
            // A new question starts a fresh draft.
            key={`${id}:${data.replyRound}`}
            reply={data.reply}
            busy={respond.isPending}
            onSubmit={submit}
          />
        ) : null}
        {data.url ? (
          <Button
            variant="secondary"
            glyph="browser"
            label="Open link"
            fullWidth
            onPress={() => openUrl(data.url!)}
          />
        ) : null}
        {data.summary ? (
          <>
            <SectionLabel>Summary</SectionLabel>
            <Text style={type.small}>
              Shown in pushes, lists and wherever the content is not.
            </Text>
            <Card>
              <Text selectable style={type.body}>
                {data.summary}
              </Text>
            </Card>
          </>
        ) : null}
        {source ? (
          <>
            <SectionLabel>
              {data.format === 'markdown' ? 'Markdown source' : 'Card markup'}
            </SectionLabel>
            <View style={styles.source}>
              <Text selectable style={[type.mono, { color: c.ink }]}>
                {source}
              </Text>
            </View>
          </>
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
                    borderTopColor: c.hairline,
                  },
                ]}
              >
                <View style={styles.header}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={type.heading}>{delivery.destinationName}</Text>
                    <Text style={type.caption}>
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
  source: {
    padding: 14,
    borderRadius: radii.md,
    backgroundColor: c.sunken,
  },
  delivery: { paddingVertical: 12, gap: 6 },
  header: { flexDirection: 'row', gap: 10, alignItems: 'center' },
});
