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
import { type PlainTranslationKey, useI18n } from '~i18n';
import { formatRelative } from '~lib/format';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import type { AppListItem } from '~server/apps';
import { setSidebarPin } from '~server/sidebar';
import { AppGlyph } from './app-glyph';
import classes from './app-library.module.css';

type Entry = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppListItem['status'];
  updatedAt: string;
  pinned: boolean;
};

type Grouping = 'name' | 'recent';

const GROUPINGS: { value: Grouping; label: PlainTranslationKey }[] = [
  { value: 'name', label: 'library.groupByName' },
  { value: 'recent', label: 'library.groupByRecent' },
];

const keyOf = (entry: Entry) => entry.id;

const byName = (a: Entry, b: Entry) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

const byRecent = (a: Entry, b: Entry) =>
  dayjs(b.updatedAt).valueOf() - dayjs(a.updatedAt).valueOf();

function recentBucket(updatedAt: string): PlainTranslationKey {
  const days = dayjs()
    .startOf('day')
    .diff(dayjs(updatedAt).startOf('day'), 'day');
  if (days <= 0) return 'library.recent.today';
  if (days < 7) return 'library.recent.thisWeek';
  if (days < 31) return 'library.recent.thisMonth';
  return 'library.recent.earlier';
}

function letterOf(name: string): string {
  const first = Array.from(name.trim())[0]?.toUpperCase() ?? '#';
  return /\p{L}/u.test(first) ? first : '#';
}

/** A group of tiles: a letter for A–Z, a translated period for Recent. */
type EntryGroup = {
  id: string;
  title: { letter: string } | { key: PlainTranslationKey };
  items: Entry[];
};

function groupEntries(entries: Entry[], grouping: Grouping): EntryGroup[] {
  const sorted = [...entries].sort(grouping === 'name' ? byName : byRecent);
  const groups: EntryGroup[] = [];
  for (const entry of sorted) {
    const title: EntryGroup['title'] =
      grouping === 'name'
        ? { letter: letterOf(entry.name) }
        : { key: recentBucket(entry.updatedAt) };
    const id = 'letter' in title ? title.letter : title.key;
    const last = groups.at(-1);
    if (last && last.id === id) last.items.push(entry);
    else groups.push({ id, title, items: [entry] });
  }
  return groups;
}

/** Which tile a right-click or long press landed on. */
function entryKeyOf(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return (
    target.closest<HTMLElement>('[data-entry-key]')?.dataset.entryKey ?? null
  );
}

/**
 * All apps: every App as a tile. A click opens it. Pointing at a
 * tile shows what it is; its actions (manage, dock, Agent) are in the
 * right-click menu, also opened by a long press or Shift+F10.
 */
export function AppLibrary({ apps }: { apps: AppListItem[] }) {
  const { t } = useI18n();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const [query, setQuery] = useState('');
  const [grouping, setGrouping] = useState<Grouping>('name');
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const pinnedApps = new Set((pins ?? []).map((pin) => pin.appId));
  const entries = apps.map((app): Entry => ({
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    status: app.status,
    updatedAt: app.updatedAt,
    pinned: pinnedApps.has(app.id),
  }));

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

  if (entries.length === 0) {
    return (
      <WindowBody>
        <EmptyState
          tone="accent"
          icon={<IconStack2 size={26} stroke={1.6} />}
          title={t('library.emptyTitle')}
          actions={
            <Button
              component={Link}
              to="/agent"
              leftSection={<IconPlus size={16} stroke={2} />}
            >
              {t('library.buildFirst')}
            </Button>
          }
        >
          {t('library.emptyBody')}
        </EmptyState>
      </WindowBody>
    );
  }

  return (
    <WindowBody>
      <Toolbar lead={t('library.count', { count: apps.length })}>
        <ToolbarSearch
          label={t('library.search')}
          value={query}
          onChange={setQuery}
        />
        <SegmentedControl
          aria-label={t('library.groupBy')}
          data={GROUPINGS.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          value={grouping}
          onChange={(value) => setGrouping(value as Grouping)}
        />
        <Button
          component={Link}
          to="/agent"
          size="md"
          leftSection={<IconPlus size={16} stroke={2} />}
        >
          {t('library.newApp')}
        </Button>
      </Toolbar>

      {matching.length === 0 ? (
        <EmptyState
          icon={<IconSearchOff size={26} stroke={1.6} />}
          title={t('library.noMatchTitle')}
          actions={
            <Button variant="default" onClick={() => setQuery('')}>
              {t('library.clearSearch')}
            </Button>
          }
        >
          {t('library.noMatchBody', { query: query.trim() })}
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
              {groups.map((group) => {
                const title =
                  'letter' in group.title
                    ? group.title.letter
                    : t(group.title.key);
                return (
                  <section key={group.id} aria-label={title}>
                    <h3 className={classes.groupHead}>
                      {title}
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
                );
              })}
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
  return (
    <Link
      to={manage ? '/app/$appSlug/manage' : '/app/$appSlug'}
      params={{ appSlug: entry.slug }}
      {...props}
    />
  );
}

/** One App: a link that opens it, with its details on hover. */
function EntryTile({
  entry,
  cardHidden,
}: {
  entry: Entry;
  cardHidden: boolean;
}) {
  const { t } = useI18n();
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
            <AppGlyph size="xl" name={entry.name} seed={entry.id} />
            {entry.pinned ? (
              <span className={classes.pinned}>
                <IconPinFilled size={9} aria-label={t('library.pinned')} />
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
          <AppGlyph size="lg" name={entry.name} seed={entry.id} />
          <div className={classes.cardTitle}>
            <span className={classes.cardName}>{entry.name}</span>
            <span className={classes.cardMeta}>
              {t('library.cardMeta', {
                when: formatRelative(entry.updatedAt),
              })}
            </span>
          </div>
        </div>
        <div className={classes.cardBadges}>
          <StatusBadge status={entry.status} />
          {entry.pinned ? (
            <span className={classes.cardFact}>{t('library.inDock')}</span>
          ) : null}
        </div>
        <p className={classes.cardText}>
          {entry.description || t('library.noDescription')}
        </p>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** What the right-click menu offers for one App. */
function EntryMenu({ entry }: { entry: Entry }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      setSidebarPin({ data: { appId: entry.id, pinned } }),
    onSuccess: (_result, pinned) => {
      toast.success(pinned ? t('dock.pinned') : t('library.removedFromDock'));
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      }),
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
        {t('common.open')}
      </Menu.Item>
      <Menu.Item
        leftSection={<IconSettings size={15} stroke={1.7} />}
        renderRoot={(props) => <EntryLink entry={entry} manage {...props} />}
      >
        {t('common.manage')}
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
        {entry.pinned ? t('library.removeFromDock') : t('library.pinToDock')}
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        leftSection={<IconSparkles size={15} stroke={1.7} />}
        renderRoot={(props) => <Link to="/agent" {...props} />}
      >
        {t('library.continueWithAgent')}
      </Menu.Item>
    </>
  );
}
