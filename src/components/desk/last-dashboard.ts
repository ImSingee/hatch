/**
 * The dashboard this browser showed last, so "Pin to desk" targets the desk
 * the person was just looking at. A per-browser convenience: it can be
 * missing (private window, cleared storage) or point at a deleted dashboard,
 * and callers then fall back to the first dashboard.
 */
const KEY = 'hatch.desk.lastDashboard';

export function rememberDashboard(dashboardId: string): void {
  try {
    localStorage.setItem(KEY, dashboardId);
  } catch {
    // Storage blocked: the fallback applies.
  }
}

export function lastDashboardId(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
