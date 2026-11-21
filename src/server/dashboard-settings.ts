import { updateDashboard } from './dashboard-service';

/** Web and native clients persist the same Dashboard refresh preference. */
export async function updateDashboardAutoRefresh(id: string, value: number) {
  const dashboard = await updateDashboard(id, { autoRefreshSeconds: value });
  return { seconds: dashboard.autoRefreshSeconds };
}
