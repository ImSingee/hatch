import {
  Outlet,
  createFileRoute,
  redirect,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { useMemo } from 'react';
import { DeskShell } from '~components/desk/desk-shell';
import type { DockOpenItem } from '~components/desk/dock-item';
import { LivePins } from '~components/desk/use-live-pins';
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

/** Windows that keep the tab bar below 560 wide: the tab destinations. */
const TAB_DESTINATIONS = ['/apps', '/settings'];

function AppLayout() {
  // The URL is the only record of what is open. The shell derives the view
  // and the dock's markers from it and hands them down; nothing below keeps a
  // "current App" of its own.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const route = useRouterState({ select: (s) => s.location.hash });
  const { dashboardId, appSlug, workflowSlug } = useParams({ strict: false });

  const openItems = useMemo<DockOpenItem[]>(() => {
    if (appSlug) return [{ kind: 'app', slug: appSlug, route }];
    if (workflowSlug) return [{ kind: 'workflow', slug: workflowSlug }];
    return [];
  }, [appSlug, workflowSlug, route]);

  return (
    <PlatformEventsProvider>
      <LivePins />
      <DeskShell
        view={dashboardId ? 'home' : 'window'}
        tabDestination={TAB_DESTINATIONS.some(
          (to) => pathname === to || pathname.startsWith(`${to}/`),
        )}
        openItems={openItems}
      >
        <Outlet />
      </DeskShell>
    </PlatformEventsProvider>
  );
}
