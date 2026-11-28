import { Menu, UnstyledButton } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  IconActivity,
  IconAdjustmentsHorizontal,
  IconBell,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconLayoutSidebarRight,
  IconLogout,
  IconMessage,
  IconPin,
  IconPower,
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
import { RunningApps, useVisibleBeside } from '~components/desk/running-apps';
import { useSessionActions } from '~components/desk/use-session-actions';
import { openContextMenuFromKeyboard } from '~components/system/context-menu-key';
import { setSidebarPin } from '~server/sidebar';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { agentRunnerStatusQueryOptions } from '~queries/agent';
import { appsQueryOptions } from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { DESKTOP_COMMAND_EVENT, parseDesktopCommand } from './host';
import classes from './desktop-shell.module.css';

/** Which App row a right-click or key press landed on. */
function rowKeyOf(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey ?? null;
}

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
  // As on the desk, an App sits beside the page in front from tablet width.
  const besideShown = useMediaQuery('(min-width: 48em)') ?? false;
  const split = useVisibleBeside(besideShown) !== null;

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
        <SidebarBody openItems={openItems} besideAvailable={besideShown} />
      </aside>
      <main id="desktop-content" className={classes.content}>
        {collapsed ? (
          <div className={classes.collapsedStrip} data-tauri-drag-region />
        ) : null}
        <div className={classes.stage} data-split={split || undefined}>
          <InsideDeskShellProvider value>
            <WindowFrameProvider value="host">
              {children}
              <RunningApps besideShown={besideShown} />
            </WindowFrameProvider>
          </InsideDeskShellProvider>
        </div>
      </main>
      <SearchPalette />
    </div>
  );
}

function SidebarBody({
  openItems,
  besideAvailable,
}: {
  openItems: readonly DockOpenItem[];
  besideAvailable: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { sessions, front, sessionOf, quit, openBeside } = useSessionActions();
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const pin = useMutation({
    mutationFn: (appId: string) =>
      setSidebarPin({ data: { appId, pinned: true } }),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: sidebarItemsQueryOptions.queryKey,
      }),
  });
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

  // Running Apps that have no pin, after the pins, as in the dock.
  const pinnedIds = new Set((pins ?? []).map((p) => p.appId));
  const pinnedSlugs = new Set((pins ?? []).map((p) => p.appSlug));
  const running = sessions
    .filter((session) =>
      session.appId
        ? !pinnedIds.has(session.appId)
        : !pinnedSlugs.has(session.slug),
    )
    .map((session) => ({
      session,
      app: apps?.find((a) =>
        session.appId ? a.id === session.appId : a.slug === session.slug,
      ),
    }));

  const menuTarget = (() => {
    if (menuKey?.startsWith('pin:')) {
      const item = pins?.find((p) => `pin:${p.id}` === menuKey);
      if (!item) return null;
      const session = sessionOf(item.appId, item.appSlug);
      return {
        name: item.label,
        appId: item.appId,
        slug: session?.slug ?? item.appSlug,
        route: item.entryHash ?? '',
        session,
        pinnable: false,
      };
    }
    const found = running.find(
      ({ session }) => `session:${session.key}` === menuKey,
    );
    if (!found) return null;
    return {
      name: found.app?.name ?? found.session.slug,
      appId: found.app?.id ?? found.session.appId ?? '',
      slug: found.session.slug,
      route: '',
      session: found.session,
      pinnable: Boolean(found.app),
    };
  })();

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
          <Menu
            shadow="md"
            width={220}
            returnFocus={false}
            onClose={() => setMenuKey(null)}
          >
            <Menu.ContextMenu>
              {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Notes which row a right-click or Shift+F10 is on; the rows stay the interactive elements. */}
              <nav
                aria-label={t('desktop.pinnedApps')}
                className={classes.list}
                onContextMenu={(event) => setMenuKey(rowKeyOf(event.target))}
                onKeyDown={(event) => {
                  setMenuKey(rowKeyOf(event.target));
                  openContextMenuFromKeyboard(event);
                }}
              >
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
                    data-row-key={`pin:${pin.id}`}
                    data-active={
                      isAppPinOpen(pin, pins ?? [], openItems) || undefined
                    }
                    data-running={
                      sessionOf(pin.appId, pin.appSlug) ? true : undefined
                    }
                  >
                    <AppGlyph name={pin.label} seed={pin.appId} size="sm" />
                    <span className={classes.name}>{pin.label}</span>
                  </Link>
                ))}
                {running.map(({ session, app }) => (
                  <Link
                    key={session.key}
                    to="/app/$appSlug"
                    params={{ appSlug: app?.slug ?? session.slug }}
                    className={classes.item}
                    data-row-key={`session:${session.key}`}
                    data-active={session.slug === front || undefined}
                    data-running
                  >
                    <AppGlyph
                      name={app?.name ?? session.slug}
                      seed={app?.id ?? session.appId ?? session.slug}
                      size="sm"
                    />
                    <span className={classes.name}>
                      {app?.name ?? session.slug}
                    </span>
                  </Link>
                ))}
              </nav>
            </Menu.ContextMenu>
            {menuTarget ? (
              <Menu.Dropdown>
                <Menu.Label>{menuTarget.name}</Menu.Label>
                {besideAvailable && front !== menuTarget.slug ? (
                  <Menu.Item
                    leftSection={
                      <IconLayoutSidebarRight size={15} stroke={1.7} />
                    }
                    onClick={() =>
                      void openBeside(
                        menuTarget.appId,
                        menuTarget.slug,
                        menuTarget.route,
                      )
                    }
                  >
                    {t('dock.openBeside')}
                  </Menu.Item>
                ) : null}
                {menuTarget.session ? (
                  <Menu.Item
                    leftSection={<IconPower size={15} stroke={1.7} />}
                    onClick={() => quit(menuTarget.session!.slug)}
                  >
                    {t('dock.quit')}
                  </Menu.Item>
                ) : null}
                {menuTarget.pinnable ? (
                  <Menu.Item
                    leftSection={<IconPin size={15} stroke={1.7} />}
                    disabled={pin.isPending}
                    onClick={() => pin.mutate(menuTarget.appId)}
                  >
                    {t('desktop.pinApp')}
                  </Menu.Item>
                ) : null}
              </Menu.Dropdown>
            ) : null}
          </Menu>
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
