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
  answeredCardHead,
  cardHead,
  hasInlineInputs,
} from '../../../packages/hatch-platform-api/notification-content';
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
import { NotificationContent } from './notification-content-view';
import classes from './notification-history.module.css';

type Version = VersionEntry<
  VersionContent & { key: string; from: string; to: string | null }
>;

const CHANGE_LABELS = {
  status: 'notifications.versions.field.status',
  format: 'notifications.versions.field.format',
  title: 'notifications.versions.field.title',
  summary: 'notifications.versions.field.summary',
  body: 'notifications.versions.field.body',
  content: 'notifications.versions.field.content',
  link: 'notifications.versions.field.link',
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
    return query.isError ? (
      <LoadFailed onRetry={() => void query.refetch()} />
    ) : (
      <Loader size="sm" aria-label={t('notifications.versions.title')} />
    );
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
      format: item.format,
      title: item.title,
      body: item.body,
      summary: item.summary,
      content: item.content,
      url: item.url,
      reply: item.reply,
      replyRound: item.replyRound,
      data,
    },
    revisions.map((revision) => ({
      key: String(revision.revision),
      from: revision.activityAt,
      to: revision.replacedAt,
      format: revision.format,
      title: revision.title,
      body: revision.body,
      summary: revision.summary,
      content: revision.content,
      url: revision.url,
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
          const answer = version.lastOfRound
            ? (answers.get(version.replyRound) ?? null)
            : undefined;
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
                {version.format === 'text' ? (
                  <>
                    <h4 className={classes.title}>{version.title}</h4>
                    {version.body ? (
                      <p className={classes.text}>{version.body}</p>
                    ) : null}
                  </>
                ) : (
                  <NotificationContent
                    format={version.format}
                    content={version.content}
                    // The current version shows the status its answer set.
                    head={
                      version.current
                        ? answeredCardHead({
                            content: version.content,
                            answers: item.response?.answers,
                            respondedAt: item.response?.respondedAt,
                            editedAt: item.editedAt,
                          })
                        : cardHead(version.content)
                    }
                    answers={answer?.answers ?? null}
                  />
                )}
                {version.url ? <NotificationLink url={version.url} /> : null}
                {version.reply ? (
                  <Question
                    reply={version.reply}
                    // A card asking inline shows its questions itself.
                    listFields={!hasInlineInputs(version.content)}
                    answer={answer}
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
      {/* A later page that failed keeps what loaded and offers the retry. */}
      {query.isFetchNextPageError ? (
        <LoadFailed onRetry={() => void query.fetchNextPage()} />
      ) : query.hasNextPage ? (
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
  listFields,
  answer,
  open,
}: {
  reply: ReplyForm;
  listFields: boolean;
  answer: NotificationResponseView | null | undefined;
  open: boolean;
}): ReactNode {
  const { t } = useI18n();
  if (!listFields && answer === undefined) return null;
  return (
    <div className={classes.question}>
      {(listFields ? reply.fields : []).map((field) => (
        <div key={field.id} className={classes.field}>
          {field.label ? (
            <span className={classes.fieldLabel}>
              {t('notifications.versions.question', { label: field.label })}
            </span>
          ) : null}
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

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className={classes.failed} role="alert">
      <span>{t('notifications.versions.loadFailed')}</span>
      <button type="button" className={classes.more} onClick={onRetry}>
        {t('common.tryAgain')}
      </button>
    </div>
  );
}
