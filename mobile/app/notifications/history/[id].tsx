import { describeAnswers, type ReplyForm } from '@hatch/platform-api';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import {
  buildVersionList,
  type VersionChange,
} from '../../../../packages/hatch-platform-api/notification-versions';
import type { NotificationAnswer } from '../../../src/core/types';
import { MobileError } from '../../../src/core';
import { useSession } from '../../../src/state/session';
import { useNotificationDeleted } from '../../../src/state/use-delete-notification';
import { Button } from '../../../src/ui/button';
import { CardBlock, CardStatus } from '../../../src/ui/notification-card';
import { notificationTime } from '../../../src/ui/notification-status';
import {
  Busy,
  EmptyState,
  Notice,
  errorText,
} from '../../../src/ui/primitives';
import { ScrollScreen } from '../../../src/ui/screen';
import { Text, type } from '../../../src/ui/text';
import {
  palette as c,
  pill,
  radii,
  status,
  weights,
} from '../../../src/ui/theme';

const CHANGE_LABELS: Record<VersionChange, string> = {
  status: 'Status',
  title: 'Title',
  body: 'Text',
  link: 'Link',
  card: 'Card',
  data: 'Data',
  question: 'New question',
  questionRemoved: 'Question removed',
};

const VIA: Record<string, string> = {
  web: 'on the web',
  mobile: 'in the app',
  push: 'from the notification',
  cli: 'from the CLI',
};

/**
 * Every version of a notification, newest first: what it says now (or said
 * when it was recalled) and each version an edit replaced, in full, with the
 * answer its question took and what changed from the version before.
 */
export default function NotificationHistoryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, origin } = useSession();
  const deleted = useNotificationDeleted(id);
  const current = useQuery({
    queryKey: [origin, 'notification', id],
    queryFn: ({ signal }) => api!.notification(id, signal),
    enabled: Boolean(api) && !deleted,
  });
  const earlier = useInfiniteQuery({
    // Keyed by the revision shown: after another edit the kept versions are
    // fetched again, never paired with the newer notification from cache.
    queryKey: [origin, 'notification', id, 'versions', current.data?.revision],
    queryFn: ({ pageParam, signal }) =>
      api!.notificationVersions(id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(api) && !deleted && current.data !== undefined,
  });

  const error = current.error ?? earlier.error;
  // Deleted (here, elsewhere, or expired): never show a cached copy.
  if (
    deleted ||
    [current.error, earlier.error].some(
      (failure) => failure instanceof MobileError && failure.status === 404,
    )
  ) {
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
  }
  if (error && !(current.data && earlier.data)) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.ground }}>
        <Notice
          tone="danger"
          title="Couldn’t load earlier versions"
          detail={errorText(error)}
          action={{
            label: 'Try again',
            onPress: () => {
              void current.refetch();
              void earlier.refetch();
            },
          }}
        />
      </View>
    );
  }
  const item = current.data;
  if (!item || !earlier.data) return <Busy label="Loading earlier versions" />;

  const answers = new Map<number, NotificationAnswer>();
  for (const page of earlier.data.pages) {
    for (const answer of page.answers) answers.set(answer.round, answer);
  }
  if (item.response) answers.set(item.response.round, item.response);

  const versions = buildVersionList(
    {
      key: 'current',
      from: item.activityAt,
      to: item.recalledAt,
      title: item.title,
      body: item.body,
      url: item.url,
      card: item.card,
      reply: item.reply,
      replyRound: item.replyRound,
    },
    earlier.data.pages
      .flatMap((page) => page.versions)
      .map((version) => ({
        key: String(version.revision),
        from: version.activityAt,
        to: version.replacedAt as string | null,
        title: version.title,
        body: version.body,
        url: version.url,
        card: version.card,
        reply: version.reply,
        replyRound: version.replyRound,
      })),
    { total: item.earlierVersions + 1 },
  );

  return (
    <ScrollScreen
      readable
      nested
      eyebrow={`${item.earlierVersions + 1} versions`}
      title={item.title}
    >
      <View style={{ paddingHorizontal: 16, gap: 18 }}>
        {item.recalledAt ? (
          <View style={styles.note} accessibilityRole="summary">
            <Text style={type.small}>
              {item.sourceName} recalled this notification on{' '}
              {notificationTime(item.recalledAt)}. Phones removed it; every
              version before the recall is kept here.
            </Text>
          </View>
        ) : null}
        {versions.map((version) => {
          const label = version.current
            ? item.recalledAt
              ? 'Before the recall'
              : 'Current'
            : version.number === 1
              ? 'Original'
              : `Version ${version.number}`;
          const when = version.to
            ? `${notificationTime(version.from)} – ${notificationTime(version.to)}`
            : `Since ${notificationTime(version.from)}`;
          return (
            <View key={version.key} style={{ gap: 6 }}>
              <View style={styles.head}>
                <View
                  style={[
                    styles.label,
                    version.current
                      ? { backgroundColor: status.info.tint }
                      : version.number === 1
                        ? { backgroundColor: c.ink }
                        : null,
                  ]}
                >
                  <Text
                    style={[
                      type.caption,
                      { fontWeight: weights.heading, color: c.ink },
                      version.number === 1 && !version.current
                        ? { color: c.card }
                        : null,
                    ]}
                  >
                    {label}
                  </Text>
                </View>
                <Text style={type.caption}>{when}</Text>
              </View>
              {version.changes.length > 0 ? (
                <Text style={[type.caption, { fontWeight: weights.strong }]}>
                  Changed from the version before:{' '}
                  {version.changes
                    .map((change) => CHANGE_LABELS[change])
                    .join(' · ')}
                </Text>
              ) : null}
              <View
                style={[
                  styles.body,
                  !version.current && { backgroundColor: c.muted },
                ]}
              >
                {version.card ? <CardStatus card={version.card} /> : null}
                <Text style={type.heading}>{version.title}</Text>
                {version.body ? (
                  <Text selectable style={type.small}>
                    {version.body}
                  </Text>
                ) : null}
                {version.card ? <CardBlock card={version.card} /> : null}
                {version.url ? (
                  <Text selectable style={[type.small, { color: c.inkSoft }]}>
                    {version.url}
                  </Text>
                ) : null}
                {version.reply ? (
                  <Question
                    reply={version.reply}
                    answer={
                      version.lastOfRound
                        ? (answers.get(version.replyRound) ?? null)
                        : undefined
                    }
                    open={version.current && !item.recalledAt}
                  />
                ) : null}
              </View>
            </View>
          );
        })}
        {/* A later page that failed keeps what loaded and offers the retry. */}
        {earlier.isFetchNextPageError ? (
          <Notice
            tone="danger"
            title="Couldn’t load earlier versions"
            detail={errorText(earlier.error)}
            action={{
              label: 'Try again',
              onPress: () => void earlier.fetchNextPage(),
            }}
          />
        ) : earlier.hasNextPage ? (
          <Button
            label="Show earlier versions"
            variant="secondary"
            busy={earlier.isFetchingNextPage}
            onPress={() => void earlier.fetchNextPage()}
          />
        ) : null}
      </View>
    </ScrollScreen>
  );
}

/** The question a version asked and, when it took it, its answer. */
function Question({
  reply,
  answer,
  open,
}: {
  reply: ReplyForm;
  answer: NotificationAnswer | null | undefined;
  open: boolean;
}) {
  return (
    <View style={styles.question}>
      {reply.fields.map((field) => (
        <View key={field.id} style={{ gap: 2 }}>
          <Text style={[type.small, { fontWeight: weights.strong }]}>
            Question: {field.label}
          </Text>
          <Text style={type.caption}>
            {field.type === 'text'
              ? 'Answered in writing'
              : `Options: ${field.options.map((option) => option.label).join(' / ')}`}
          </Text>
        </View>
      ))}
      {answer === undefined ? null : answer ? (
        <Text
          style={[
            type.small,
            { fontWeight: weights.strong, color: status.success.ink },
          ]}
        >
          ✓ {answer.respondedByName} answered “
          {describeAnswers(reply, answer.answers)
            .map((line) => line.value)
            .join(' · ')}
          ” {VIA[answer.via] ?? ''}
        </Text>
      ) : (
        <Text style={type.caption}>
          {open ? 'Not answered yet' : 'Nobody answered'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: c.muted,
  },
  head: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: pill,
    backgroundColor: c.muted,
  },
  body: {
    gap: 8,
    padding: 14,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.hairline,
    backgroundColor: c.card,
  },
  question: {
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
  },
});
