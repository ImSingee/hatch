import { UnstyledButton } from '@mantine/core';
import {
  Spotlight,
  type SpotlightActionGroupData,
  spotlight,
} from '@mantine/spotlight';
import { useQuery } from '@tanstack/react-query';
import { type LinkProps, useNavigate } from '@tanstack/react-router';
import {
  IconActivity,
  IconApps,
  IconBell,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconStack2,
} from '@tabler/icons-react';
import { useMemo, type ReactNode } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import { appsQueryOptions } from '~queries/apps';
import { workflowsQueryOptions } from '~queries/workflows';
import { DESK_HOME } from './paths';
import classes from './menu-bar.module.css';

const PLACES: {
  id: string;
  label: string;
  icon: ReactNode;
  link: LinkProps;
}[] = [
  {
    id: 'desk',
    label: 'Desk',
    icon: <IconLayoutGrid />,
    link: { to: DESK_HOME },
  },
  {
    id: 'agent',
    label: 'Agent',
    icon: <IconSparkles />,
    link: { to: '/agent' },
  },
  { id: 'apps', label: 'All apps', icon: <IconApps />, link: { to: '/apps' } },
  {
    id: 'workflows',
    label: 'Workflows',
    icon: <IconStack2 />,
    link: { to: '/workflows' },
  },
  {
    id: 'executions',
    label: 'Executions',
    icon: <IconActivity />,
    link: { to: '/executions' },
  },
  {
    id: 'dashboards',
    label: 'Dashboards',
    icon: <IconLayoutDashboard />,
    link: { to: '/dashboards' },
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: <IconBell />,
    link: { to: '/notifications' },
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: <IconSettings />,
    link: { to: '/settings' },
  },
];

const placeIcon = (icon: ReactNode) => (
  <span className={classes.paletteIcon} aria-hidden>
    {icon}
  </span>
);

/**
 * Search across the places of the desk, every App and every Workflow,
 * opened from the menu bar or with ⌘K / Ctrl+K anywhere in the shell.
 */
export function CommandPalette() {
  return (
    <>
      <UnstyledButton
        className={`${classes.item} ${classes.search}`}
        aria-label="Search apps, workflows and pages"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => spotlight.open()}
      >
        <IconSearch size={17} stroke={1.9} aria-hidden />
        <kbd className={classes.kbd} aria-hidden>
          ⌘K
        </kbd>
      </UnstyledButton>
      <SearchPalette />
    </>
  );
}

/**
 * The palette itself, without the menu bar's trigger. Other shells (the macOS
 * app's sidebar) mount it with a trigger of their own and open it with
 * `spotlight.open()`.
 */
export function SearchPalette() {
  const navigate = useNavigate();
  const apps = useQuery(appsQueryOptions);
  const workflows = useQuery(workflowsQueryOptions);

  const actions = useMemo<SpotlightActionGroupData[]>(
    () => [
      {
        group: 'Go to',
        actions: PLACES.map((place) => ({
          id: `place-${place.id}`,
          label: place.label,
          leftSection: placeIcon(place.icon),
          onClick: () => void navigate(place.link),
        })),
      },
      {
        group: 'Apps',
        actions: (apps.data ?? [])
          .filter((app) => app.status !== 'archived')
          .map((app) => ({
            id: `app-${app.id}`,
            label: app.name,
            description: app.description ?? undefined,
            keywords: [app.slug],
            leftSection: <AppGlyph name={app.name} seed={app.id} size="sm" />,
            onClick: () =>
              void navigate(
                app.status === 'deployed' && app.capabilities?.frontend
                  ? { to: '/app/$appSlug', params: { appSlug: app.slug } }
                  : {
                      to: '/app/$appSlug/manage',
                      params: { appSlug: app.slug },
                    },
              ),
          })),
      },
      {
        group: 'Workflows',
        actions: (workflows.data ?? [])
          .filter((workflow) => workflow.status !== 'archived')
          .map((workflow) => ({
            id: `workflow-${workflow.id}`,
            label: workflow.name,
            description: workflow.description ?? undefined,
            keywords: [workflow.slug],
            leftSection: (
              <AppGlyph name={workflow.name} seed={workflow.id} size="sm" />
            ),
            onClick: () =>
              void navigate({
                to: '/workflow/$workflowSlug',
                params: { workflowSlug: workflow.slug },
              }),
          })),
      },
    ],
    [apps.data, workflows.data, navigate],
  );

  return (
    <Spotlight
      actions={actions}
      shortcut={['mod + K']}
      // Nothing in the shell uses ⌘K inside a field, so the palette opens
      // from search boxes and the Agent composer too.
      tagsToIgnore={[]}
      triggerOnContentEditable
      nothingFound="Nothing matches. Try an App, Workflow or page name."
      highlightQuery
      scrollable
      maxHeight={420}
      searchProps={{
        leftSection: <IconSearch size={18} stroke={1.8} />,
        placeholder: 'Search apps, workflows and pages',
        'aria-label': 'Search apps, workflows and pages',
      }}
    />
  );
}
