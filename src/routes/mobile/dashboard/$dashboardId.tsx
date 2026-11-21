import { createFileRoute, redirect } from '@tanstack/react-router';
import { MobileDashboardCanvas } from '~components/dashboard/mobile-dashboard-canvas';
import { hasActiveSession } from '~server/auth';
import { useNativeHostDocument } from '~ui/theme';

// The native client owns navigation; this route stays outside the web App shell.
export const Route = createFileRoute('/mobile/dashboard/$dashboardId')({
  beforeLoad: async () => {
    if (!(await hasActiveSession())) throw redirect({ to: '/login' });
  },
  component: MobileDashboard,
});

function MobileDashboard() {
  const { dashboardId } = Route.useParams();
  // The native app draws the ground behind this page; see native-host.ts.
  useNativeHostDocument();
  return <MobileDashboardCanvas key={dashboardId} dashboardId={dashboardId} />;
}
