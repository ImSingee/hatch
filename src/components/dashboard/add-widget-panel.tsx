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
import type { AppListItem } from '~server/apps';
import type { AvailableWidget, DashboardItem } from '~server/dashboards';
import { dashboardWidgetKey } from '~/lib/dashboard-widget';
import { REFRESH_PRESETS, formatInterval } from './refresh-presets';
import { refreshText } from './desk-toolbar';
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
          Add widgets
        </h2>
        <ActionIcon
          variant="light"
          color="gray"
          size={30}
          radius="md"
          aria-label="Close the panel and stop editing"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          <IconX size={14} stroke={2.2} />
        </ActionIcon>
      </div>

      <div className={classes.body}>
        <section
          aria-labelledby="add-widgets-available"
          className={classes.group}
        >
          <div className={classes.groupHead}>
            <h3 id="add-widgets-available" className={classes.groupTitle}>
              Widgets you can add
            </h3>
            <span className={classes.count}>
              {addedCount} of {available.length} added
            </span>
          </div>
          {available.length > SEARCH_THRESHOLD ? (
            <TextInput
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              leftSection={<IconSearch size={15} stroke={1.8} />}
              placeholder="Search widgets"
              aria-label="Search widgets"
            />
          ) : null}
          {available.length === 0 ? (
            <div className={classes.none}>
              <IconPuzzle size={20} stroke={1.7} aria-hidden />
              <Text size="sm" fw={700}>
                No App offers a widget yet
              </Text>
              <Text size="xs" c="dimmed">
                Ask the Agent to add one to an App you use.
              </Text>
            </div>
          ) : filtered.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No matching widgets
            </Text>
          ) : (
            <ul className={classes.list}>
              {filtered.map((widget) => {
                const added = placedKeys.has(dashboardWidgetKey(widget));
                return (
                  <li key={dashboardWidgetKey(widget)} className={classes.row}>
                    <AppGlyph
                      name={widget.appName}
                      seed={widget.appId}
                      size="md"
                    />
                    <div className={classes.rowText}>
                      <strong className={classes.rowName}>{widget.name}</strong>
                      <span className={classes.rowMeta}>
                        From {widget.appName}
                      </span>
                    </div>
                    {added ? (
                      <span className={classes.added}>
                        <IconCheck size={13} stroke={2.6} aria-hidden />
                        Added
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="compact-sm"
                        variant="default"
                        leftSection={<IconPlus size={13} stroke={2.4} />}
                        disabled={disabled}
                        aria-label={`Add ${widget.name}`}
                        onClick={() => onAdd(widget)}
                      >
                        Add
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {withoutWidgets.length > 0 ? (
          <section
            aria-labelledby="add-widgets-others"
            className={classes.group}
          >
            <div className={classes.groupHead}>
              <h3 id="add-widgets-others" className={classes.groupTitle}>
                Other apps
              </h3>
              <span className={classes.count}>{withoutWidgets.length}</span>
            </div>
            <div className={classes.others}>
              <Text size="sm" fw={700}>
                These apps have no widget yet
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
                    search={{ prompt: 'Add a dashboard widget to ' }}
                    {...props}
                  />
                )}
              >
                Ask the Agent to make a widget ›
              </Anchor>
            </div>
          </section>
        ) : null}

        <section
          aria-labelledby="add-widgets-refresh"
          className={classes.group}
        >
          <h3 id="add-widgets-refresh" className={classes.groupTitle}>
            Auto refresh
          </h3>
          <div className={classes.refresh}>
            <SegmentedControl
              fullWidth
              size="xs"
              value={String(autoRefreshSeconds)}
              onChange={(value) => onAutoRefreshChange(Number(value))}
              aria-labelledby="add-widgets-refresh"
              data={intervals.map((seconds) => ({
                value: String(seconds),
                label:
                  seconds === 0
                    ? 'Off'
                    : (REFRESH_PRESETS.find((p) => p.seconds === seconds)
                        ?.label ?? formatInterval(seconds)),
              }))}
            />
            <Text size="xs" c="dimmed">
              {refreshText(autoRefreshSeconds)}. Applies to every widget on this
              dashboard and is saved right away.
            </Text>
          </div>
        </section>

        <div className={classes.footer}>
          <Button
            type="button"
            variant="default"
            className={classes.cancel}
            disabled={cancelDisabled}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className={classes.done}
            loading={saving}
            disabled={disabled}
            onClick={onDone}
          >
            Done
          </Button>
        </div>
      </div>
    </aside>
  );
}
