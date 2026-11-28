import {
  Outlet,
  createFileRoute,
  redirect,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { useMemo } from 'react';
import {
  AppSessionsProvider,
  WEB_RUNNING_APP_LIMIT,
  useAppSessions,
} from '~components/desk/app-sessions';
import { DeskShell } from '~components/desk/desk-shell';
import type { DockOpenItem } from '~components/desk/dock-item';
import { LivePins } from '~components/desk/use-live-pins';
import { DesktopShell } from '~components/desktop-host/desktop-shell';
import { isDesktopHost } from '~components/desktop-host/host';
import { PlatformEventsProvider } from '~components/system/platform-events';
import { hasActiveSession } from '~server/auth';

export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ location }) => {
    const authenticated = await hasActiveSession();
    if (!authenticated) {
      // Carry the attempted URL so /login can return the user to their deep
      // link after authenticating instead of always landing on /dashboard.
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
    // This guard intentionally receives only a boolean. The Better Auth session
    // token stays in its HttpOnly cookie, while server functions independently
    // enforce authorization through authMiddleware/requireSession. The client
    // reads display-safe user information through authClient.useSession().
  },
  component: AppLayout,
});

/** Inside the macOS app the sidebar layout replaces the desk's bars. */
const DESKTOP_HOST = isDesktopHost();

/** Windows that keep the tab bar below 560 wide: the tab destinations. */
const TAB_DESTINATIONS = ['/apps', '/settings'];

function AppLayout() {
  return (
    <PlatformEventsProvider>
      {/* The macOS app runs as many Apps as the desk, side by side too: its
          sidebar marks them and quits them, and it runs `native` Apps in
          native views of its own. */}
      <AppSessionsProvider limit={WEB_RUNNING_APP_LIMIT} besideEnabled>
        <LivePins />
        <AppLayoutShell />
      </AppSessionsProvider>
    </PlatformEventsProvider>
  );
}

function AppLayoutShell() {
  // The URL says which window is in front; the session manager says which
  // Apps are running. The shell derives the view and the dock's markers from
  // them and hands them down.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { dashboardId } = useParams({ strict: false });
  const { sessions, front } = useAppSessions();

  // The dock marks every running App. The macOS sidebar highlights the row
  // of the page on screen and marks the others it runs itself, so it gets
  // only the App in front.
  const openItems = useMemo<DockOpenItem[]>(
    () =>
      sessions
        .filter((session) => !DESKTOP_HOST || session.slug === front)
        .map((session) => ({
          kind: 'app',
          slug: session.slug,
          route: session.route,
        })),
    [sessions, front],
  );

  return DESKTOP_HOST ? (
    <DesktopShell openItems={openItems}>
      <Outlet />
    </DesktopShell>
  ) : (
    <DeskShell
      view={dashboardId ? 'home' : 'window'}
      tabDestination={TAB_DESTINATIONS.some(
        (to) => pathname === to || pathname.startsWith(`${to}/`),
      )}
      openItems={openItems}
    >
      <Outlet />
    </DeskShell>
  );
}
