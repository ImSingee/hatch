import {
  ActionIcon,
  Button,
  Center,
  Loader,
  Menu,
  Select,
  Tooltip,
} from '@mantine/core';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconBell, IconDotsVertical, IconTrash } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { EmptyState } from '~components/page/page';
import { useI18n } from '~i18n';
import { formatExact, formatRelativeTime } from '~lib/format';
import {
  notificationHistoryQueryOptions,
  notificationSourcesQueryOptions,
  type NotificationFilters,
} from '~queries/notifications';
import type {
  NotificationReplyState,
  NotificationStatus,
} from '~server/notifications';
import {
  NOTIFICATION_STATUS_OPTIONS,
  NotificationPriorityBadge,
  NotificationReplyBadge,
  NotificationRevisionBadge,
  REPLY_STATE_OPTIONS,
  NotificationStatusBadge,
  SourceTypeIcon,
} from './status';
import { useDeleteNotification } from './use-delete-notification';
import classes from './notifications-window.module.css';

function parseSource(
  value: string | null,
): Pick<NotificationFilters, 'sourceType' | 'sourceId'> {
  if (!value) return {};
  if (value === 'platform' || value === 'user') return { sourceType: value };
  const [type, id] = value.split(':');
  return {
    sourceType: type === 'app' ? 'app' : 'channel',
    sourceId: id,
  };
}

/**
 * The list half of the Notifications window: filters, then every
 * notification as a row that opens it on the right.
 */
export function NotificationHistory({
  selected,
}: {
  /** The open notification's id. */
  selected?: string;
}) {
  const { t, locale } = useI18n();
  const [source, setSource] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [replyState, setReplyState] = useState<NotificationReplyState | null>(
    null,
  );
  const { data: sources } = useQuery(notificationSourcesQueryOptions);

  const filters: NotificationFilters = {
    ...parseSource(source),
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
    ...(replyState ? { replyState } : {}),
  };
  const history = useInfiniteQuery(notificationHistoryQueryOptions(filters));
  const { confirmDelete } = useDeleteNotification();

  const sourceOptions = useMemo(
    () => [
      ...(sources?.apps.length
        ? [
            {
              group: t('notifications.history.source.apps'),
              items: sources.apps.map((app) => ({
                value: `app:${app.id}`,
                label: app.name,
              })),
            },
          ]
        : []),
      ...(sources?.channels.length
        ? [
            {
              group: t('notifications.history.source.channels'),
              items: sources.channels.map((channel) => ({
                value: `channel:${channel.id}`,
                label: channel.name,
              })),
            },
          ]
        : []),
      {
        group: 'Hatch',
        items: [
          { value: 'user', label: t('notifications.history.source.user') },
          {
            value: 'platform',
            label: t('notifications.history.source.platform'),
          },
        ],
      },
    ],
    [sources, t],
  );

  const kindOptions = useMemo(() => {
    const selected = parseSource(source);
    const all = [
      ...(sources?.apps ?? []).map((app) => ({
        type: 'app',
        id: app.id,
        kinds: app.kinds,
      })),
      ...(sources?.channels ?? []).map((channel) => ({
        type: 'channel',
        id: channel.id,
        kinds: channel.kinds,
      })),
      { type: 'user', id: null, kinds: sources?.userKinds ?? [] },
    ].filter(
      (entry) =>
        !selected.sourceType ||
        (entry.type === selected.sourceType &&
          (!selected.sourceId || entry.id === selected.sourceId)),
    );
    const seen = new Map<string, string>();
    for (const entry of all) {
      for (const k of entry.kinds) {
        if (!seen.has(k.kind)) seen.set(k.kind, `${k.name} · ${k.kind}`);
      }
    }
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [source, sources]);

  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(source || kind || status || replyState);

  return (
    <>
      <div className={classes.filters}>
        <Select
          placeholder={t('notifications.history.filter.allSources')}
          aria-label={t('notifications.history.filter.source')}
          data={sourceOptions}
          value={source}
          onChange={(value) => {
            setSource(value);
            setKind(null);
          }}
          clearable
          searchable
          comboboxProps={{ width: 260, position: 'bottom-start' }}
        />
        <Select
          placeholder={t('notifications.history.filter.allKinds')}
          aria-label={t('notifications.history.filter.kind')}
          data={kindOptions}
          value={kind}
          onChange={setKind}
          clearable
          searchable
          disabled={kindOptions.length === 0}
          comboboxProps={{ width: 280, position: 'bottom-end' }}
        />
        <Select
          placeholder={t('notifications.history.filter.anyStatus')}
          aria-label={t('notifications.history.filter.status')}
          data={NOTIFICATION_STATUS_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          value={status}
          onChange={(value) => setStatus(value as NotificationStatus | null)}
          clearable
          comboboxProps={{ width: 220, position: 'bottom-start' }}
        />
        <Select
          placeholder={t('notifications.history.filter.anyReplyState')}
          aria-label={t('notifications.history.filter.replyState')}
          data={REPLY_STATE_OPTIONS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          value={replyState}
          onChange={(value) =>
            setReplyState(value as NotificationReplyState | null)
          }
          clearable
          comboboxProps={{ width: 220, position: 'bottom-end' }}
        />
      </div>

      <div className={classes.scroll}>
        {history.isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : items.length === 0 ? (
          <EmptyState
            variant="dashed"
            icon={<IconBell size={20} stroke={1.8} />}
            title={
              filtered
                ? t('notifications.history.empty.filteredTitle')
                : t('notifications.history.empty.title')
            }
            actions={
              !filtered ? (
                <Button
                  component={Link}
                  to="/settings/notifications"
                  variant="default"
                >
                  {t('notifications.history.empty.setUp')}
                </Button>
              ) : undefined
            }
          >
            {filtered
              ? t('notifications.history.empty.filteredBody')
              : t('notifications.history.empty.body')}
          </EmptyState>
        ) : (
          <>
            <ul
              className={classes.rows}
              aria-label={t('notifications.history.list')}
            >
              {items.map((item) => (
                <li
                  key={item.id}
                  className={classes.row}
                  data-current={item.id === selected || undefined}
                >
                  <Link
                    to="/notifications/$notificationId"
                    params={{ notificationId: item.id }}
                    className={classes.link}
                    aria-current={item.id === selected ? 'page' : undefined}
                  >
                    <span className={classes.titleLine}>
                      <span className={classes.title}>{item.title}</span>
                      <Tooltip label={formatExact(item.createdAt)} withArrow>
                        <span className={classes.time}>
                          {formatRelativeTime(item.createdAt, locale)}
                        </span>
                      </Tooltip>
                    </span>
                    <span className={classes.meta}>
                      <SourceTypeIcon type={item.sourceType} size={14} />
                      <span className={classes.metaText}>
                        {item.sourceName} · {item.kindName}
                        {item.body ? ` · ${item.body}` : ''}
                      </span>
                    </span>
                    <span className={classes.badges}>
                      <NotificationStatusBadge status={item.status} />
                      <NotificationPriorityBadge priority={item.priority} />
                      <NotificationRevisionBadge
                        editedAt={item.editedAt}
                        recalledAt={item.recalledAt}
                      />
                      <NotificationReplyBadge
                        hasReply={item.reply !== null}
                        respondedAt={item.respondedAt}
                        recalledAt={item.recalledAt}
                      />
                    </span>
                  </Link>
                  <div className={classes.menu}>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          aria-label={t('notifications.actionsFor', {
                            name: item.title,
                          })}
                        >
                          <IconDotsVertical size={15} stroke={1.8} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} stroke={1.6} />}
                          onClick={() => confirmDelete(item)}
                        >
                          {t('common.delete')}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </div>
                </li>
              ))}
            </ul>
            {history.hasNextPage ? (
              <div className={classes.more}>
                <Button
                  variant="default"
                  loading={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  {t('notifications.history.loadMore')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
