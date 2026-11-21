import { Anchor, Button, Drawer, SegmentedControl } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  IconPinFilled,
  IconPlus,
  IconSearchOff,
  IconStack2,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  EmptyState,
  Toolbar,
  ToolbarSearch,
  WindowBody,
} from '~components/page/page';
import { StatusBadge } from '~components/system/status-badge';
import { formatRelative } from '~lib/format';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { workflowsQueryOptions } from '~queries/workflows';
import type { AppListItem } from '~server/apps';
import { setSidebarPin } from '~server/sidebar';
import { setWorkflowPinFn, type WorkflowListItem } from '~server/workflows';
import { AppGlyph } from './app-glyph';
import classes from './app-library.module.css';

type Entry = {
  kind: 'app' | 'workflow';
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppListItem['status'] | WorkflowListItem['status'];
  updatedAt: string;
  pinned: boolean;
};

type Grouping = 'kind' | 'name' | 'recent';

const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'kind', label: 'Kind' },
  { value: 'name', label: 'A–Z' },
  { value: 'recent', label: 'Recent' },
];

const keyOf = (entry: Entry) => `${entry.kind}:${entry.id}`;

const byName = (a: Entry, b: Entry) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

const byRecent = (a: Entry, b: Entry) =>
  dayjs(b.updatedAt).valueOf() - dayjs(a.updatedAt).valueOf();

function recentBucket(updatedAt: string): string {
  const days = dayjs()
    .startOf('day')
    .diff(dayjs(updatedAt).startOf('day'), 'day');
  if (days <= 0) return 'Today';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Earlier';
}

function letterOf(name: string): string {
  const first = Array.from(name.trim())[0]?.toUpperCase() ?? '#';
  return /\p{L}/u.test(first) ? first : '#';
}

function groupEntries(
  entries: Entry[],
  grouping: Grouping,
): { title: string; items: Entry[] }[] {
  if (grouping === 'kind') {
    return [
      { title: 'Apps', items: entries.filter((e) => e.kind === 'app') },
      {
        title: 'Workflows',
        items: entries.filter((e) => e.kind === 'workflow'),
      },
    ]
      .map((group) => ({ ...group, items: [...group.items].sort(byName) }))
      .filter((group) => group.items.length > 0);
  }
  const sorted = [...entries].sort(grouping === 'name' ? byName : byRecent);
  const groups: { title: string; items: Entry[] }[] = [];
  for (const entry of sorted) {
    const title =
      grouping === 'name'
        ? letterOf(entry.name)
        : recentBucket(entry.updatedAt);
    const last = groups.at(-1);
    if (last?.title === title) last.items.push(entry);
    else groups.push({ title, items: [entry] });
  }
  return groups;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * All apps: every App and Workflow as a tile. Picking a tile shows what it
 * is and what can be done with it; double-clicking opens it.
 */
export function AppLibrary({ apps }: { apps: AppListItem[] }) {
  const navigate = useNavigate();
  const { data: workflows } = useQuery(workflowsQueryOptions);
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const narrow = useMediaQuery('(max-width: 50em)') ?? false;
  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('kind');
  const [picked, setPicked] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const pinnedApps = new Set((pins ?? []).map((pin) => pin.appId));
  const entries: Entry[] = [
    ...apps.map((app): Entry => ({
      kind: 'app',
      id: app.id,
      slug: app.slug,
      name: app.name,
      description: app.description,
      status: app.status,
      updatedAt: app.updatedAt,
      pinned: pinnedApps.has(app.id),
    })),
    ...(workflows ?? []).map((workflow): Entry => ({
      kind: 'workflow',
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      updatedAt: workflow.updatedAt,
      pinned: workflow.pinned,
    })),
  ];

  const needle = query.trim().toLowerCase();
  const matching = needle
    ? entries.filter((entry) =>
        `${entry.name} ${entry.slug} ${entry.description ?? ''}`
          .toLowerCase()
          .includes(needle),
      )
    : entries;
  const groups = groupEntries(matching, grouping);
  const selected =
    matching.find((entry) => keyOf(entry) === picked) ??
    groups[0]?.items[0] ??
    null;

  const open = (entry: Entry) =>
    entry.kind === 'app'
      ? navigate({ to: '/app/$appSlug', params: { appSlug: entry.slug } })
      : navigate({
          to: '/workflow/$workflowSlug',
          params: { workflowSlug: entry.slug },
        });

  const workflowCount = workflows?.length ?? 0;

  if (entries.length === 0) {
    return (
      <WindowBody>
        <EmptyState
          tone="accent"
          icon={<IconStack2 size={26} stroke={1.6} />}
          title="No apps yet"
          actions={
            <Button
              component={Link}
              to="/agent"
              leftSection={<IconPlus size={16} stroke={2} />}
            >
              Build your first app
            </Button>
          }
        >
          Open the Agent and describe what you want — a tracker, a CRM, a
          dashboard — and it will scaffold, build, and deploy it here.
        </EmptyState>
      </WindowBody>
    );
  }

  return (
    <WindowBody>
      <Toolbar
        lead={
          workflowCount > 0
            ? `${plural(apps.length, 'app')} · ${plural(workflowCount, 'workflow')}`
            : plural(apps.length, 'app')
        }
      >
        <ToolbarSearch
          label="Search apps and workflows"
          value={query}
          onChange={setQuery}
        />
        <SegmentedControl
          aria-label="Group by"
          data={GROUPINGS}
          value={grouping}
          onChange={(value) => setGrouping(value as Grouping)}
        />
        <Button
          component={Link}
          to="/agent"
          size="md"
          leftSection={<IconPlus size={16} stroke={2} />}
        >
          New app
        </Button>
      </Toolbar>

      {matching.length === 0 ? (
        <EmptyState
          icon={<IconSearchOff size={26} stroke={1.6} />}
          title="Nothing matches"
          actions={
            <Button variant="default" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        >
          No app or workflow matches “{query.trim()}”.
        </EmptyState>
      ) : (
        <div className={classes.layout}>
          <div className={classes.groups}>
            {groups.map((group) => (
              <section key={group.title} aria-label={group.title}>
                <h3 className={classes.groupHead}>
                  {group.title}
                  <span className={classes.groupCount}>
                    {group.items.length}
                  </span>
                  <span className={classes.groupRule} aria-hidden />
                </h3>
                <div className={classes.grid}>
                  {group.items.map((entry) => (
                    <button
                      key={keyOf(entry)}
                      type="button"
                      className={classes.tile}
                      aria-pressed={
                        !narrow && selected !== null
                          ? keyOf(selected) === keyOf(entry)
                          : undefined
                      }
                      title={`${entry.name} — double-click to open`}
                      onClick={() => {
                        setPicked(keyOf(entry));
                        if (narrow) setSheetOpen(true);
                      }}
                      onDoubleClick={() => void open(entry)}
                    >
                      <span className={classes.tileIcon}>
                        <AppGlyph
                          size="xl"
                          name={entry.name}
                          seed={entry.id}
                          icon={entry.kind === 'app'}
                          shape={entry.kind}
                        />
                        {entry.pinned ? (
                          <span className={classes.pinned}>
                            <IconPinFilled size={9} aria-label="Pinned" />
                          </span>
                        ) : null}
                      </span>
                      <span className={classes.tileName}>{entry.name}</span>
                      <span className={classes.tileMeta}>
                        {formatRelative(entry.updatedAt)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {selected ? <EntryDetail entry={selected} /> : null}
        </div>
      )}

      <Drawer
        opened={narrow && sheetOpen && selected !== null}
        onClose={() => setSheetOpen(false)}
        position="bottom"
        size="auto"
        title={selected?.kind === 'workflow' ? 'Workflow' : 'App'}
      >
        {selected ? <EntryDetail entry={selected} inline /> : null}
      </Drawer>
    </WindowBody>
  );
}

function EntryDetail({ entry, inline }: { entry: Entry; inline?: boolean }) {
  const queryClient = useQueryClient();
  const pin = useMutation({
    mutationFn: async (pinned: boolean) => {
      if (entry.kind === 'app')
        await setSidebarPin({ data: { appId: entry.id, pinned } });
      else await setWorkflowPinFn({ data: { id: entry.id, pinned } });
    },
    onSuccess: (_result, pinned) => {
      toast.success(pinned ? 'Pinned to the dock' : 'Removed from the dock');
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: sidebarItemsQueryOptions.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: workflowsQueryOptions.queryKey,
        }),
      ]),
  });
  const isApp = entry.kind === 'app';

  return (
    <aside
      className={classes.detail}
      data-inline={inline || undefined}
      aria-label={`${entry.name} details`}
    >
      <AppGlyph
        size="hero"
        name={entry.name}
        seed={entry.id}
        icon={isApp}
        shape={entry.kind}
      />
      <div>
        <h3 className={classes.detailName}>{entry.name}</h3>
        <span className={classes.detailMeta}>
          {isApp ? 'App' : 'Workflow'} · Updated{' '}
          {formatRelative(entry.updatedAt)}
        </span>
      </div>
      <StatusBadge status={entry.status} />
      <p className={classes.detailText}>
        {entry.description || 'No description yet.'}
      </p>
      <div className={classes.fact}>
        <span>Dock</span>
        <span className={classes.factValue}>
          {entry.pinned ? 'Pinned' : 'Not pinned'}
        </span>
      </div>
      <div className={classes.actions}>
        {isApp ? (
          <>
            <Button
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug"
                  params={{ appSlug: entry.slug }}
                  {...props}
                />
              )}
            >
              Open
            </Button>
            <Button
              variant="default"
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug/manage"
                  params={{ appSlug: entry.slug }}
                  {...props}
                />
              )}
            >
              Manage
            </Button>
          </>
        ) : (
          <>
            <Button
              renderRoot={(props) => (
                <Link
                  to="/workflow/$workflowSlug"
                  params={{ workflowSlug: entry.slug }}
                  {...props}
                />
              )}
            >
              Open
            </Button>
            <Button
              variant="default"
              renderRoot={(props) => (
                <Link
                  to="/workflow/$workflowSlug/manage"
                  params={{ workflowSlug: entry.slug }}
                  {...props}
                />
              )}
            >
              Manage
            </Button>
          </>
        )}
      </div>
      <Button
        variant="default"
        loading={pin.isPending}
        onClick={() => pin.mutate(!entry.pinned)}
      >
        {entry.pinned ? 'Remove from dock' : 'Pin to dock'}
      </Button>
      <Anchor component={Link} to="/agent" size="sm">
        Continue editing with the Agent ›
      </Anchor>
    </aside>
  );
}
