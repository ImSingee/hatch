import { Avatar, Menu, UnstyledButton } from '@mantine/core';
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
  IconRepeat,
  IconSearch,
} from '@tabler/icons-react';
import { spotlight } from '@mantine/spotlight';
import { type ReactNode, useEffect, useEffectEvent, useState } from 'react';
import { authClient } from '~auth/client';
import { useSignOut } from '~auth/use-sign-out';
import { AppGlyph } from '~components/apps/app-glyph';
import {
  InsideDeskShellProvider,
  WindowFrameProvider,
} from '~components/desk/desk-context';
import { SearchPalette } from '~components/desk/command-palette';
import type { DockOpenItem } from '~components/desk/dock-item';
import { isAppPinOpen } from '~components/desk/dock';
import { DESK_HOME } from '~components/desk/paths';
import { agentRunnerStatusQueryOptions } from '~queries/agent';
import { appsQueryOptions } from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { workflowsQueryOptions } from '~queries/workflows';
import { DESKTOP_COMMAND_EVENT, parseDesktopCommand } from './host';
import classes from './desktop-shell.module.css';

function isUnder(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * The signed-in layout inside the macOS app (`Mac-App` artboard): a sidebar
 * with search (the desk's own palette), the primary sections and the pinned
 * Apps and Workflows, and
 * the page beside it. It replaces the desk's menu bar and dock; the pages
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
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  const onCommand = useEffectEvent((event: Event) => {
    const command = parseDesktopCommand((event as CustomEvent).detail);
    if (!command) return;
    event.preventDefault();
    if (command.type === 'navigate') void navigate({ to: command.to });
    if (command.type === 'toggle-sidebar') setCollapsed((value) => !value);
    if (command.type === 'focus-search') spotlight.open();
  });
  useEffect(() => {
    window.addEventListener(DESKTOP_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(DESKTOP_COMMAND_EVENT, onCommand);
  }, []);

  return (
    <div className={classes.shell} data-collapsed={collapsed || undefined}>
      <a href="#desktop-content" className={classes.skip}>
        Skip to content
      </a>
      <aside className={classes.sidebar} aria-label="Sidebar">
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
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);
  const { data: workflows } = useQuery(workflowsQueryOptions);
  const pinnedWorkflows = (workflows ?? []).filter((w) => w.pinned);

  const sections = [
    {
      to: DESK_HOME,
      label: 'Desk',
      icon: IconLayoutDashboard,
      active: isUnder(pathname, '/dashboard'),
    },
    {
      to: '/agent',
      label: 'Agent',
      icon: IconMessage,
      active: isUnder(pathname, '/agent'),
    },
    {
      to: '/apps',
      label: 'All apps',
      icon: IconLayoutGrid,
      active: isUnder(pathname, '/apps'),
      count: apps?.length,
    },
    {
      to: '/workflows',
      label: 'Workflows',
      icon: IconRepeat,
      active: isUnder(pathname, '/workflows'),
      count: workflows?.length,
    },
    {
      to: '/settings',
      label: 'Settings',
      icon: IconAdjustmentsHorizontal,
      active: isUnder(pathname, '/settings'),
      hint: '⌘,',
    },
  ] as const;

  return (
    <>
      <UnstyledButton
        className={classes.search}
        aria-label="Search apps, workflows and pages"
        aria-keyshortcuts="Meta+K"
        onClick={() => spotlight.open()}
      >
        <IconSearch size={14} stroke={2.2} aria-hidden />
        <span className={classes.searchLabel}>Search</span>
        <span className={classes.kbd} aria-hidden>
          ⌘K
        </span>
      </UnstyledButton>

      <div className={classes.scroll}>
        <>
          <nav aria-label="Primary" className={classes.list}>
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
                <span className={classes.name}>{section.label}</span>
                {'count' in section && section.count !== undefined ? (
                  <span className={classes.kbd}>{section.count}</span>
                ) : null}
                {'hint' in section ? (
                  <span className={classes.kbd}>{section.hint}</span>
                ) : null}
              </Link>
            ))}
          </nav>

          <h2 className={classes.heading}>Apps</h2>
          <nav aria-label="Pinned apps" className={classes.list}>
            {pins && pins.length === 0 ? (
              <span className={classes.empty}>Pin apps from All apps</span>
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

          {pinnedWorkflows.length > 0 ? (
            <>
              <h2 className={classes.heading}>Workflows</h2>
              <nav aria-label="Pinned workflows" className={classes.list}>
                {pinnedWorkflows.map((workflow) => (
                  <Link
                    key={workflow.id}
                    to="/workflow/$workflowSlug"
                    params={{ workflowSlug: workflow.slug }}
                    className={classes.item}
                    data-active={
                      openItems.some(
                        (item) =>
                          item.kind === 'workflow' &&
                          item.slug === workflow.slug,
                      ) || undefined
                    }
                  >
                    <span className={classes.workflowTile}>
                      <AppGlyph
                        name={workflow.name}
                        seed={workflow.id}
                        size="sm"
                        icon={false}
                      />
                    </span>
                    <span className={classes.name}>{workflow.name}</span>
                  </Link>
                ))}
              </nav>
            </>
          ) : null}
        </>
      </div>

      <AccountFooter />
    </>
  );
}

function AccountFooter() {
  const { signOut, leaving } = useSignOut();
  const { data } = authClient.useSession();
  const { data: runner } = useQuery(agentRunnerStatusQueryOptions);
  const email = data?.user.email ?? '';
  const name = data?.user.name || email || 'Account';
  const connected = runner?.summary.connectedRunners ?? 0;
  const state = runner?.state ?? 'offline';

  return (
    <Menu position="top-start" width={220} shadow="md">
      <Menu.Target>
        <UnstyledButton className={classes.account} aria-label="Account menu">
          <Avatar
            size={28}
            radius="xl"
            name={name}
            color="primary"
            variant="filled"
          />
          <span className={classes.accountText}>
            <span className={classes.accountName}>{name}</span>
            <span className={classes.runner} data-state={state}>
              <span className={classes.dot} aria-hidden />
              {state === 'offline'
                ? 'Runner offline'
                : state === 'attention'
                  ? 'Runner needs attention'
                  : `${connected} runner${connected === 1 ? '' : 's'} online`}
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
          Notifications
        </Menu.Item>
        <Menu.Item
          leftSection={<IconLayoutDashboard size={16} stroke={1.6} />}
          renderRoot={(props) => <Link to="/dashboards" {...props} />}
        >
          Dashboards
        </Menu.Item>
        <Menu.Item
          leftSection={<IconActivity size={16} stroke={1.6} />}
          renderRoot={(props) => (
            <Link to="/settings/agent-runner" {...props} />
          )}
        >
          Agent Runner status
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={<IconLogout size={16} stroke={1.6} />}
          onClick={signOut}
          disabled={leaving}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
