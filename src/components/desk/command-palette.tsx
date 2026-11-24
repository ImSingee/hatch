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
} from '@tabler/icons-react';
import { useMemo, type ReactNode } from 'react';
import { AppGlyph } from '~components/apps/app-glyph';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { appsQueryOptions } from '~queries/apps';
import { DESK_HOME } from './paths';
import classes from './menu-bar.module.css';

const PLACES: {
  id: string;
  label: PlainTranslationKey;
  icon: ReactNode;
  link: LinkProps;
}[] = [
  {
    id: 'desk',
    label: 'nav.desk',
    icon: <IconLayoutGrid />,
    link: { to: DESK_HOME },
  },
  {
    id: 'agent',
    label: 'nav.agent',
    icon: <IconSparkles />,
    link: { to: '/agent' },
  },
  {
    id: 'apps',
    label: 'nav.allApps',
    icon: <IconApps />,
    link: { to: '/apps' },
  },
  {
    id: 'executions',
    label: 'nav.executions',
    icon: <IconActivity />,
    link: { to: '/executions' },
  },
  {
    id: 'dashboards',
    label: 'nav.dashboards',
    icon: <IconLayoutDashboard />,
    link: { to: '/dashboards' },
  },
  {
    id: 'notifications',
    label: 'nav.notifications',
    icon: <IconBell />,
    link: { to: '/notifications' },
  },
  {
    id: 'settings',
    label: 'nav.settings',
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
 * Search across the places of the desk and every App,
 * opened from the menu bar or with ⌘K / Ctrl+K anywhere in the shell.
 */
export function CommandPalette() {
  const { t } = useI18n();
  return (
    <>
      <UnstyledButton
        className={`${classes.item} ${classes.search}`}
        aria-label={t('palette.search')}
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
  const { t } = useI18n();
  const navigate = useNavigate();
  const apps = useQuery(appsQueryOptions);

  const actions = useMemo<SpotlightActionGroupData[]>(
    () => [
      {
        group: t('palette.goTo'),
        actions: PLACES.map((place) => ({
          id: `place-${place.id}`,
          label: t(place.label),
          leftSection: placeIcon(place.icon),
          onClick: () => void navigate(place.link),
        })),
      },
      {
        group: t('palette.apps'),
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
    ],
    [apps.data, navigate, t],
  );

  return (
    <Spotlight
      actions={actions}
      shortcut={['mod + K']}
      // Nothing in the shell uses ⌘K inside a field, so the palette opens
      // from search boxes and the Agent composer too.
      tagsToIgnore={[]}
      triggerOnContentEditable
      nothingFound={t('palette.nothingFound')}
      highlightQuery
      scrollable
      maxHeight={420}
      searchProps={{
        leftSection: <IconSearch size={18} stroke={1.8} />,
        placeholder: t('palette.search'),
        'aria-label': t('palette.search'),
      }}
    />
  );
}
