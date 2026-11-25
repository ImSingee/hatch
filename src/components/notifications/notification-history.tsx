/**
 * Every version of a notification, newest first: what it says now (or said
 * when it was recalled) and each version an edit replaced, each in full with
 * the answer its question took and what changed from the version before.
 * The timeline shows it in a side panel, the delivery log on the detail page
 * (there with each version's `data`).
 */
import { Code, Loader } from '@mantine/core';
import { useInfiniteQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';
import { useI18n, type PlainTranslationKey } from '~i18n';
import { notificationRevisionsQueryOptions } from '~queries/notifications';
import type {
  NotificationResponseView,
  NotificationSummaryView,
} from '~server/notifications';
import {
  describeAnswers,
  type ReplyForm,
} from '../../../packages/hatch-platform-api/notification-reply';
import {
  buildVersionList,
  type VersionChange,
  type VersionContent,
  type VersionEntry,
} from '../../../packages/hatch-platform-api/notification-versions';
import { NotificationLink } from './notification-link';
import { CardBlock, CardStatus } from './notification-card-view';
import classes from './notification-history.module.css';

type Version = VersionEntry<
  VersionContent & { key: string; from: string; to: string | null }
>;

const CHANGE_LABELS = {
  status: 'notifications.versions.field.status',
  title: 'notifications.versions.field.title',
  body: 'notifications.versions.field.body',
  link: 'notifications.versions.field.link',
  card: 'notifications.versions.field.card',
  data: 'notifications.versions.field.data',
  question: 'notifications.versions.field.question',
  questionRemoved: 'notifications.versions.field.questionRemoved',
} as const satisfies Record<VersionChange, PlainTranslationKey>;

export function NotificationHistory({
  item,
  data,
  showData = false,
}: {
  item: NotificationSummaryView;
  /** The current version's `data`, shown with `showData`. */
  data?: Record<string, unknown> | null;
  showData?: boolean;
}) {
  const { t } = useI18n();
  const query = useInfiniteQuery(notificationRevisionsQueryOptions(item.id));
  if (!query.data) {
    return <Loader size="sm" aria-label={t('notifications.versions.title')} />;
  }
  const total = item.earlierVersions + 1;
  const revisions = query.data.pages.flatMap((page) => page.revisions);
  const answers = new Map<number, NotificationResponseView>();
  for (const page of query.data.pages) {
    for (const response of page.responses)
      answers.set(response.round, response);
  }
  if (item.response) answers.set(item.response.round, item.response);

  const versions: Version[] = buildVersionList(
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
      data,
    },
    revisions.map((revision) => ({
      key: String(revision.revision),
      from: revision.activityAt,
      to: revision.replacedAt,
      title: revision.title,
      body: revision.body,
      url: revision.url,
      card: revision.card,
      reply: revision.reply,
      replyRound: revision.replyRound,
      data: revision.data,
    })),
    { total, compareData: showData },
  );

  const label = (version: Version) => {
    if (version.current) {
      return item.recalledAt
        ? t('notifications.versions.beforeRecall')
        : t('notifications.versions.current');
    }
    if (version.number === 1) return t('notifications.versions.original');
    return t('notifications.versions.version', { number: version.number });
  };
  const when = (version: Version) => {
    const from = dayjs(version.from).format('MM-DD HH:mm');
    if (!version.to) return t('notifications.versions.since', { time: from });
    const to = dayjs(version.to).format('MM-DD HH:mm');
    return version.current && item.recalledAt
      ? t('notifications.versions.untilRecall', { from, to })
      : t('notifications.versions.range', { from, to });
  };

  return (
    <div className={classes.history}>
      {item.recalledAt ? (
        <p className={classes.recalled} role="note">
          {t('notifications.versions.recalledNote', {
            source: item.sourceName,
            time: dayjs(item.recalledAt).format('MM-DD HH:mm'),
          })}
        </p>
      ) : null}
      <ol className={classes.versions}>
        {versions.map((version) => {
          const { changes } = version;
          return (
            <li key={version.key} className={classes.version}>
              <div className={classes.head}>
                <span
                  className={classes.label}
                  data-kind={
                    version.current
                      ? 'current'
                      : version.number === 1
                        ? 'original'
                        : undefined
                  }
                >
                  {label(version)}
                </span>
                <span className={classes.when}>{when(version)}</span>
              </div>
              {changes.length > 0 ? (
                <p className={classes.changes}>
                  {t('notifications.versions.changes', {
                    fields: changes
                      .map((change) => t(CHANGE_LABELS[change]))
                      .join(' · '),
                  })}
                </p>
              ) : null}
              <div className={classes.body} data-current={version.current}>
                {version.card?.status ? (
                  <CardStatus card={version.card} />
                ) : null}
                <h4 className={classes.title}>{version.title}</h4>
                {version.body ? (
                  <p className={classes.text}>{version.body}</p>
                ) : null}
                {version.card?.block ? <CardBlock card={version.card} /> : null}
                {version.url ? <NotificationLink url={version.url} /> : null}
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
                {showData && version.data ? (
                  <div className={classes.data}>
                    <span className={classes.dataLabel}>
                      {t('notifications.detail.data')}
                    </span>
                    <Code block className={classes.code}>
                      {JSON.stringify(version.data, null, 2)}
                    </Code>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {query.hasNextPage ? (
        <button
          type="button"
          className={classes.more}
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('notifications.versions.more')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The question a version asked: each field with its options, then the
 * answer when this version took it. `answer` is undefined when a later
 * version of the same round shows it.
 */
function Question({
  reply,
  answer,
  open,
}: {
  reply: ReplyForm;
  answer: NotificationResponseView | null | undefined;
  open: boolean;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className={classes.question}>
      {reply.fields.map((field) => (
        <div key={field.id} className={classes.field}>
          <span className={classes.fieldLabel}>
            {t('notifications.versions.question', { label: field.label })}
          </span>
          <span className={classes.options}>
            {field.type === 'text'
              ? t('notifications.versions.textAnswer')
              : t('notifications.versions.options', {
                  options: field.options
                    .map((option) => option.label)
                    .join(' / '),
                })}
          </span>
        </div>
      ))}
      {answer === undefined ? null : answer ? (
        <p className={classes.answer} data-answered="true">
          {t('notifications.timeline.answeredBy', {
            name: answer.respondedBy.name,
            answer: describeAnswers(reply, answer.answers)
              .map((line) => line.value)
              .join(' · '),
            via: t(`notifications.timeline.via.${answer.via}`),
          })}
        </p>
      ) : (
        <p className={classes.answer}>
          {open
            ? t('notifications.versions.notAnswered')
            : t('notifications.versions.noAnswer')}
        </p>
      )}
    </div>
  );
}
