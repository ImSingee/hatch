import { Button, HoverCard, Menu, SegmentedControl, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlus,
  IconSearchOff,
  IconSettings,
  IconSparkles,
  IconStack2,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import {
  EmptyState,
  Toolbar,
  ToolbarSearch,
  WindowBody,
} from '~components/page/page';
import { openContextMenuFromKeyboard } from '~components/system/context-menu-key';
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

/** Which tile a right-click or long press landed on. */
function entryKeyOf(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return (
    target.closest<HTMLElement>('[data-entry-key]')?.dataset.entryKey ?? null
  );
}

/**
 * All apps: every App and Workflow as a tile. A click opens it. Pointing at a
 * tile shows what it is; its actions (manage, dock, Agent) are in the
 * right-click menu, also opened by a long press or Shift+F10.
 */
export function AppLibrary({ apps }: { apps: AppListItem[] }) {
  const { data: workflows } = useQuery(workflowsQueryOptions);
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('kind');
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
  const menuEntry = entries.find((entry) => keyOf(entry) === menuKey) ?? null;
  const noteTarget = (target: EventTarget | null) =>
    setMenuKey(entryKeyOf(target));

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
        <Menu
          shadow="md"
          width={230}
          onOpen={() => setMenuOpen(true)}
          onClose={() => setMenuOpen(false)}
        >
          <Menu.ContextMenu>
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Notes which tile a right-click, long press or Shift+F10 is on; the tiles stay the interactive elements. */}
            <div
              className={classes.groups}
              onContextMenu={(event) => noteTarget(event.target)}
              // A long press opens the menu without a contextmenu event.
              onTouchStart={(event) => noteTarget(event.target)}
              onKeyDown={openContextMenuFromKeyboard}
            >
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
                      <EntryTile
                        key={keyOf(entry)}
                        entry={entry}
                        cardHidden={menuOpen}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </Menu.ContextMenu>
          <Menu.Dropdown>
            {menuEntry ? <EntryMenu entry={menuEntry} /> : null}
          </Menu.Dropdown>
        </Menu>
      )}
    </WindowBody>
  );
}

/** The link a tile or a menu item opens. */
function EntryLink({
  entry,
  manage,
  ...props
}: {
  entry: Entry;
  manage?: boolean;
  className?: string;
  children?: ReactNode;
  'data-entry-key'?: string;
}) {
  return entry.kind === 'app' ? (
    <Link
      to={manage ? '/app/$appSlug/manage' : '/app/$appSlug'}
      params={{ appSlug: entry.slug }}
      {...props}
    />
  ) : (
    <Link
      to={manage ? '/workflow/$workflowSlug/manage' : '/workflow/$workflowSlug'}
      params={{ workflowSlug: entry.slug }}
      {...props}
    />
  );
}

/** One App or Workflow: a link that opens it, with its details on hover. */
function EntryTile({
  entry,
  cardHidden,
}: {
  entry: Entry;
  cardHidden: boolean;
}) {
  const isApp = entry.kind === 'app';
  return (
    <HoverCard
      openDelay={500}
      closeDelay={80}
      position="bottom"
      width={280}
      disabled={cardHidden}
    >
      <HoverCard.Target>
        <EntryLink
          entry={entry}
          className={classes.tile}
          data-entry-key={keyOf(entry)}
        >
          <span className={classes.tileIcon}>
            <AppGlyph
              size="xl"
              name={entry.name}
              seed={entry.id}
              icon={isApp}
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
        </EntryLink>
      </HoverCard.Target>
      <HoverCard.Dropdown className={classes.card}>
        <div className={classes.cardHead}>
          <AppGlyph
            size="lg"
            name={entry.name}
            seed={entry.id}
            icon={isApp}
            shape={entry.kind}
          />
          <div className={classes.cardTitle}>
            <span className={classes.cardName}>{entry.name}</span>
            <span className={classes.cardMeta}>
              {isApp ? 'App' : 'Workflow'} · Updated{' '}
              {formatRelative(entry.updatedAt)}
            </span>
          </div>
        </div>
        <div className={classes.cardBadges}>
          <StatusBadge status={entry.status} />
          {entry.pinned ? (
            <span className={classes.cardFact}>In the dock</span>
          ) : null}
        </div>
        <p className={classes.cardText}>
          {entry.description || 'No description yet.'}
        </p>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** What the right-click menu offers for one App or Workflow. */
function EntryMenu({ entry }: { entry: Entry }) {
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

  return (
    <>
      <Menu.Label>
        <Text component="span" size="xs" fw={700} truncate display="block">
          {entry.name}
        </Text>
      </Menu.Label>
      <Menu.Item
        leftSection={<IconAppWindow size={15} stroke={1.7} />}
        renderRoot={(props) => <EntryLink entry={entry} {...props} />}
      >
        Open
      </Menu.Item>
      <Menu.Item
        leftSection={<IconSettings size={15} stroke={1.7} />}
        renderRoot={(props) => <EntryLink entry={entry} manage {...props} />}
      >
        Manage
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        leftSection={
          entry.pinned ? (
            <IconPinnedOff size={15} stroke={1.7} />
          ) : (
            <IconPin size={15} stroke={1.7} />
          )
        }
        disabled={pin.isPending}
        onClick={() => pin.mutate(!entry.pinned)}
      >
        {entry.pinned ? 'Remove from dock' : 'Pin to dock'}
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        leftSection={<IconSparkles size={15} stroke={1.7} />}
        renderRoot={(props) => <Link to="/agent" {...props} />}
      >
        Continue with the Agent
      </Menu.Item>
    </>
  );
}
