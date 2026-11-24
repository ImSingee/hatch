import {
  ActionIcon,
  Anchor,
  Button,
  SegmentedControl,
  Text,
  TextInput,
} from '@mantine/core';
import { Link } from '@tanstack/react-router';
import {
  IconCheck,
  IconLayoutGridAdd,
  IconPlus,
  IconPuzzle,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import {
  EmptyLine,
  EmptyState,
  GroupCard,
  Item,
  Section,
} from '~components/page/page';
import type { AppListItem } from '~server/apps';
import type { AvailableWidget, DashboardItem } from '~server/dashboards';
import { dashboardWidgetKey } from '~/lib/dashboard-widget';
import { useI18n } from '~i18n';
import { formatIntervalLabel } from './refresh-presets';
import classes from './add-widget-panel.module.css';

/** The intervals the panel offers; the current one is added when it differs. */
const OFFERED_INTERVALS = [0, 10, 60, 300, 900, 3600];
/** Show a search field once the list is longer than this. */
const SEARCH_THRESHOLD = 8;

/**
 * The editor's side panel: widgets to add, Apps that have none, and the
 * refresh interval, with Cancel and Done. Adding and removing change the
 * draft only; the interval is a dashboard setting and is saved at once.
 */
export function AddWidgetPanel({
  available,
  placed,
  apps,
  onAdd,
  disabled = false,
  autoRefreshSeconds,
  onAutoRefreshChange,
  onCancel,
  onDone,
  cancelDisabled,
  saving,
}: {
  available: AvailableWidget[];
  placed: DashboardItem[];
  apps: AppListItem[];
  onAdd: (widget: AvailableWidget) => void;
  disabled?: boolean;
  autoRefreshSeconds: number;
  onAutoRefreshChange: (seconds: number) => void;
  onCancel: () => void;
  onDone: () => void;
  cancelDisabled: boolean;
  saving: boolean;
}) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');
  const placedKeys = useMemo(
    () => new Set(placed.map(dashboardWidgetKey)),
    [placed],
  );
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return available;
    return available.filter((widget) =>
      `${widget.name} ${widget.appName}`.toLocaleLowerCase().includes(term),
    );
  }, [available, search]);
  const addedCount = available.filter((widget) =>
    placedKeys.has(dashboardWidgetKey(widget)),
  ).length;
  const appsWithWidgets = new Set(available.map((widget) => widget.appId));
  const withoutWidgets = apps.filter(
    (app) => app.status !== 'archived' && !appsWithWidgets.has(app.id),
  );
  const intervals = [
    ...new Set([...OFFERED_INTERVALS, autoRefreshSeconds]),
  ].sort((left, right) => left - right);

  return (
    <aside aria-labelledby="add-widgets-title" className={classes.panel}>
      <div className={classes.titleBar}>
        <span className={classes.titleTile} aria-hidden>
          <IconLayoutGridAdd size={14} stroke={2} />
        </span>
        <h2 id="add-widgets-title" className={classes.title}>
          {t('dashboard.addPanel.title')}
        </h2>
        <ActionIcon
          variant="light"
          color="gray"
          size={30}
          radius="md"
          aria-label={t('dashboard.addPanel.close')}
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          <IconX size={14} stroke={2.2} />
        </ActionIcon>
      </div>

      <div className={classes.body}>
        <Section
          title={t('dashboard.addPanel.available')}
          aside={
            <span className={classes.count}>
              {t('dashboard.addPanel.addedCount', {
                added: addedCount,
                total: available.length,
              })}
            </span>
          }
        >
          {available.length > SEARCH_THRESHOLD ? (
            <TextInput
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              leftSection={<IconSearch size={15} stroke={1.8} />}
              placeholder={t('dashboard.addPanel.search')}
              aria-label={t('dashboard.addPanel.search')}
            />
          ) : null}
          {available.length === 0 ? (
            <EmptyState
              variant="dashed"
              icon={<IconPuzzle size={20} stroke={1.7} />}
              title={t('dashboard.addPanel.noneTitle')}
            >
              {t('dashboard.addPanel.noneBody')}
            </EmptyState>
          ) : filtered.length === 0 ? (
            <EmptyLine>{t('dashboard.addPanel.noMatches')}</EmptyLine>
          ) : (
            <GroupCard component="ul">
              {filtered.map((widget) => {
                const added = placedKeys.has(dashboardWidgetKey(widget));
                return (
                  <Item
                    key={dashboardWidgetKey(widget)}
                    component="li"
                    lead={
                      <AppGlyph
                        name={widget.appName}
                        seed={widget.appId}
                        size="md"
                      />
                    }
                    title={widget.name}
                    meta={t('dashboard.addPanel.from', { app: widget.appName })}
                    trailing={
                      added ? (
                        <span className={classes.added}>
                          <IconCheck size={13} stroke={2.6} aria-hidden />
                          {t('dashboard.addPanel.added')}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="compact-sm"
                          variant="default"
                          leftSection={<IconPlus size={13} stroke={2.4} />}
                          disabled={disabled}
                          aria-label={t('dashboard.addPanel.addWidget', {
                            name: widget.name,
                          })}
                          onClick={() => onAdd(widget)}
                        >
                          {t('common.add')}
                        </Button>
                      )
                    }
                  />
                );
              })}
            </GroupCard>
          )}
        </Section>

        {withoutWidgets.length > 0 ? (
          <Section
            title={t('dashboard.addPanel.otherApps')}
            aside={
              <span className={classes.count}>{withoutWidgets.length}</span>
            }
          >
            <GroupCard padded dashed>
              <div className={classes.others}>
                <Text size="sm" fw={700}>
                  {t('dashboard.addPanel.noWidgetApps')}
                </Text>
                <ul className={classes.otherList}>
                  {withoutWidgets.map((app) => (
                    <li key={app.id} className={classes.otherItem}>
                      <AppGlyph name={app.name} seed={app.id} size="sm" />
                      <span className={classes.otherName}>{app.name}</span>
                    </li>
                  ))}
                </ul>
                <Anchor
                  size="sm"
                  renderRoot={(props) => (
                    <Link
                      to="/agent"
                      search={{ prompt: t('dashboard.agentPrompt.addWidget') }}
                      {...props}
                    />
                  )}
                >
                  {t('dashboard.addPanel.askAgent')}
                </Anchor>
              </div>
            </GroupCard>
          </Section>
        ) : null}

        <Section title={t('dashboard.addPanel.autoRefresh')}>
          <GroupCard padded>
            <SegmentedControl
              fullWidth
              size="xs"
              value={String(autoRefreshSeconds)}
              onChange={(value) => onAutoRefreshChange(Number(value))}
              aria-label={t('dashboard.addPanel.autoRefresh')}
              data={intervals.map((seconds) => ({
                value: String(seconds),
                label:
                  seconds === 0
                    ? t('dashboard.refresh.offOption')
                    : formatIntervalLabel(seconds, locale),
              }))}
            />
            <Text size="xs" c="dimmed">
              {autoRefreshSeconds > 0
                ? t('dashboard.addPanel.refreshHintOn', {
                    interval: formatIntervalLabel(autoRefreshSeconds, locale),
                  })
                : t('dashboard.addPanel.refreshHintOff')}
            </Text>
          </GroupCard>
        </Section>

        <div className={classes.footer}>
          <Button
            type="button"
            variant="default"
            className={classes.cancel}
            disabled={cancelDisabled}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className={classes.done}
            loading={saving}
            disabled={disabled}
            onClick={onDone}
          >
            {t('common.done')}
          </Button>
        </div>
      </div>
    </aside>
  );
}
