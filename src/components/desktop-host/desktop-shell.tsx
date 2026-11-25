import { Menu, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconBell,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconLogout,
  IconMessage,
  IconSearch,
} from '@tabler/icons-react';
import { spotlight } from '@mantine/spotlight';
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import { authClient } from '~auth/client';
import { useSignOut } from '~auth/use-sign-out';
import { AppGlyph } from '~components/apps/app-glyph';
import { UserAvatar } from '~components/auth/user-avatar';
import {
  InsideDeskShellProvider,
  WindowFrameProvider,
} from '~components/desk/desk-context';
import { SearchPalette } from '~components/desk/command-palette';
import type { DockOpenItem } from '~components/desk/dock-item';
import { isAppPinOpen } from '~components/desk/dock';
import { DESK_HOME } from '~components/desk/paths';
import { platformShortcutKeys } from '~components/desk/platform-shortcuts';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { agentRunnerStatusQueryOptions } from '~queries/agent';
import { appsQueryOptions } from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { DESKTOP_COMMAND_EVENT, parseDesktopCommand } from './host';
import classes from './desktop-shell.module.css';

function isUnder(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * The signed-in layout inside the macOS app (`Mac-App` artboard): a sidebar
 * with search (the desk's own palette), the primary sections and the pinned
 * Apps, and the page beside it. It replaces the desk's menu bar and dock; the pages
 * themselves are the same as on the web. The window's traffic lights sit over
 * the sidebar's top strip, which also drags the window.
 */
export function DesktopShell({
  openItems,
  children,
}: {
  openItems: readonly DockOpenItem[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  const onCommand = useEffectEvent((event: Event) => {
    const command = parseDesktopCommand((event as CustomEvent).detail);
    if (!command) return;
    event.preventDefault();
    if (command.type === 'navigate') void navigate({ to: command.to });
    if (command.type === 'toggle-sidebar') setCollapsed((value) => !value);
    // Only a click on the menu item: ⌘K itself is a platform shortcut the
    // page handles, so Apps that reserve it receive it.
    if (command.type === 'focus-search') spotlight.open();
  });
  useEffect(() => {
    window.addEventListener(DESKTOP_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(DESKTOP_COMMAND_EVENT, onCommand);
  }, []);

  return (
    <div className={classes.shell} data-collapsed={collapsed || undefined}>
      <a href="#desktop-content" className={classes.skip}>
        {t('desktop.skipToContent')}
      </a>
      <aside className={classes.sidebar} aria-label={t('desktop.sidebar')}>
        <div className={classes.titleStrip} data-tauri-drag-region />
        <SidebarBody openItems={openItems} />
      </aside>
      <main id="desktop-content" className={classes.content}>
        {collapsed ? (
          <div className={classes.collapsedStrip} data-tauri-drag-region />
        ) : null}
        <div className={classes.stage}>
          <InsideDeskShellProvider value>
            <WindowFrameProvider value="host">{children}</WindowFrameProvider>
          </InsideDeskShellProvider>
        </div>
      </main>
      <SearchPalette />
    </div>
  );
}

function SidebarBody({ openItems }: { openItems: readonly DockOpenItem[] }) {
  const { t } = useI18n();
  const searchKeys = platformShortcutKeys('palette.open');
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);

  const sections: {
    to: string;
    label: PlainTranslationKey;
    icon: typeof IconLayoutDashboard;
    active: boolean;
    count?: number;
    hint?: string;
  }[] = [
    {
      to: DESK_HOME,
      label: 'nav.desk',
      icon: IconLayoutDashboard,
      active: isUnder(pathname, '/dashboard'),
    },
    {
      to: '/agent',
      label: 'nav.agent',
      icon: IconMessage,
      active: isUnder(pathname, '/agent'),
    },
    {
      to: '/apps',
      label: 'nav.allApps',
      icon: IconLayoutGrid,
      active: isUnder(pathname, '/apps'),
      count: apps?.length,
    },
    {
      to: '/settings',
      label: 'nav.settings',
      icon: IconAdjustmentsHorizontal,
      active: isUnder(pathname, '/settings'),
      hint: '⌘,',
    },
  ];

  return (
    <>
      <UnstyledButton
        className={classes.search}
        aria-label={t('palette.search')}
        aria-keyshortcuts={searchKeys.aria}
        onClick={() => spotlight.open()}
      >
        <IconSearch size={14} stroke={2.2} aria-hidden />
        <span className={classes.searchLabel}>{t('desktop.search')}</span>
        <span className={classes.kbd} aria-hidden>
          {searchKeys.label}
        </span>
      </UnstyledButton>

      <div className={classes.scroll}>
        <>
          <nav aria-label={t('desktop.primary')} className={classes.list}>
            {sections.map((section) => (
              <Link
                key={section.to}
                to={section.to}
                className={classes.section}
                data-active={section.active || undefined}
              >
                <section.icon
                  size={16}
                  stroke={2}
                  aria-hidden
                  className={classes.sectionIcon}
                />
                <span className={classes.name}>{t(section.label)}</span>
                {section.count !== undefined ? (
                  <span className={classes.kbd}>{section.count}</span>
                ) : null}
                {section.hint ? (
                  <span className={classes.kbd}>{section.hint}</span>
                ) : null}
              </Link>
            ))}
          </nav>

          <h2 className={classes.heading}>{t('desktop.appsHeading')}</h2>
          <nav aria-label={t('desktop.pinnedApps')} className={classes.list}>
            {pins && pins.length === 0 ? (
              <span className={classes.empty}>{t('desktop.pinHint')}</span>
            ) : null}
            {(pins ?? []).map((pin) => (
              <Link
                key={pin.id}
                to="/app/$appSlug"
                params={{ appSlug: pin.appSlug }}
                hash={pin.entryHash ?? undefined}
                className={classes.item}
                data-active={
                  isAppPinOpen(pin, pins ?? [], openItems) || undefined
                }
              >
                <AppGlyph name={pin.label} seed={pin.appId} size="sm" />
                <span className={classes.name}>{pin.label}</span>
              </Link>
            ))}
          </nav>
        </>
      </div>

      <AccountFooter />
    </>
  );
}

function AccountFooter() {
  const { t } = useI18n();
  const { signOut, leaving } = useSignOut();
  const { data } = authClient.useSession();
  const { data: runner } = useQuery(agentRunnerStatusQueryOptions);
  const email = data?.user.email ?? '';
  const name = data?.user.name || email || t('desktop.accountFallback');
  const connected = runner?.summary.connectedRunners ?? 0;
  const state = runner?.state ?? 'offline';

  return (
    <Menu position="top-start" width={220} shadow="md">
      <Menu.Target>
        <UnstyledButton
          className={classes.account}
          aria-label={t('nav.accountMenu')}
        >
          <UserAvatar
            userId={data?.user.id}
            image={data?.user.image}
            name={name}
            size={28}
          />
          <span className={classes.accountText}>
            <span className={classes.accountName}>{name}</span>
            <span className={classes.runner} data-state={state}>
              <span className={classes.dot} aria-hidden />
              {state === 'offline'
                ? t('desktop.runnerOffline')
                : state === 'attention'
                  ? t('desktop.runnerAttention')
                  : t('desktop.runnersOnline', { count: connected })}
            </span>
          </span>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {email ? <Menu.Label>{email}</Menu.Label> : null}
        <Menu.Item
          leftSection={<IconBell size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/notifications" {...props} />}
        >
          {t('nav.notifications')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          {t('nav.dashboards')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconActivity size={16} stroke={1.6} />}
          renderRoot={(props) => (
            <Link to="/settings/agent-runner" {...props} />
          )}
        >
          {t('desktop.runnerStatus')}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLogout size={16} stroke={1.6} />}
          onClick={signOut}
          disabled={leaving}
        >
          {t('common.signOut')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
