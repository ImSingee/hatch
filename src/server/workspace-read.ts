import { and, asc, eq, sql } from 'drizzle-orm';
import { db, schema, type TX } from '~/db';
import { DEFAULT_HOMEPAGE } from '~/homepage';

export type Dashboard = {
  id: string;
  name: string;
  description: string | null;
  /** Whether the viewing user pinned it to their navigation. */
  pinned: boolean;
  /** Auto-refresh interval in seconds; 0 disables auto-refresh. */
  autoRefreshSeconds: number;
};

/** Make sure at least one dashboard always exists for the UI to land on. */
async function ensureDefaultDashboard(): Promise<void> {
  const existing = await db.query.dashboards.findFirst({
    columns: { id: true },
  });
  if (existing) return;
  await db
    .insert(schema.dashboards)
    .values({ id: 'default', name: 'My Dashboard' })
    .onConflictDoNothing();
}

/**
 * A new user's first visit pins one dashboard: the default one, first in the
 * order they see (the oldest, which the homepage also falls back to). It
 * happens once per user, when `dashboardDefaultsApplied` turns true, so
 * unpinning it sticks and losing every dashboard row later (the dashboards
 * were deleted) never pins another one. Concurrent first visits flip the flag
 * once: the later upsert finds it already set and pins nothing.
 */
export async function pinDefaultDashboardForNewUser(
  tx: TX,
  userId: string,
): Promise<void> {
  // Most reads are by users past their first visit: no lock for them.
  const applied = await tx.query.userPreferences.findFirst({
    where: { userId },
    columns: { dashboardDefaultsApplied: true },
  });
  if (applied?.dashboardDefaultsApplied) return;
  // The oldest dashboard nobody is deleting right now; the lock keeps it
  // from being deleted until this transaction ends, so the pin cannot fail.
  const [candidate] = await tx
    .select({ id: schema.dashboards.id })
    .from(schema.dashboards)
    .orderBy(asc(schema.dashboards.createdAt), asc(schema.dashboards.id))
    .limit(1)
    .for('key share', { skipLocked: true });
  // Nothing to pin yet (an empty instance): the default waits for a later
  // visit instead of being used up.
  if (!candidate) return;
  const preferences = schema.userPreferences;
  const flipped = await tx
    .insert(preferences)
    // A first preference row needs a homepage; the default is what the user
    // already gets without one.
    .values({
      userId,
      homepage: DEFAULT_HOMEPAGE,
      dashboardDefaultsApplied: true,
    })
    .onConflictDoUpdate({
      target: preferences.userId,
      set: { dashboardDefaultsApplied: true },
      setWhere: eq(preferences.dashboardDefaultsApplied, false),
    })
    .returning({ userId: preferences.userId });
  if (!flipped.length) return;
  await tx
    .insert(schema.userDashboards)
    .values({ userId, dashboardId: candidate.id, pinned: true, sortOrder: 0 })
    .onConflictDoNothing();
}

/**
 * Every dashboard in the user's order, with their pinned flag. Dashboards the
 * user has no row for are unpinned and come after the rest, oldest first;
 * without a user (a Run nobody prompted) that is every dashboard.
 */
export async function readUserDashboards(
  database: Pick<TX, 'select'>,
  userId: string | null,
) {
  const view = schema.userDashboards;
  return database
    .select({
      id: schema.dashboards.id,
      name: schema.dashboards.name,
      description: schema.dashboards.description,
      autoRefresh: schema.dashboards.autoRefresh,
      pinned: view.pinned,
    })
    .from(schema.dashboards)
    .leftJoin(
      view,
      and(
        eq(view.dashboardId, schema.dashboards.id),
        userId === null ? sql`false` : eq(view.userId, userId),
      ),
    )
    .orderBy(
      sql`${view.sortOrder} asc nulls last`,
      asc(schema.dashboards.createdAt),
      asc(schema.dashboards.id),
    );
}

export async function readDashboards(
  userId: string | null,
): Promise<Dashboard[]> {
  await ensureDefaultDashboard();
  if (userId)
    await db.transaction((tx) => pinDefaultDashboardForNewUser(tx, userId));
  const rows = await readUserDashboards(db, userId);
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    pinned: d.pinned ?? false,
    autoRefreshSeconds: d.autoRefresh,
  }));
}

export type SidebarItem = {
  id: string;
  appId: string;
  appSlug: string;
  label: string;
  /** Hash entry point within the app (no leading '#'); null opens the root. */
  entryHash: string | null;
  status: schema.AppStatus;
};

/** The user's App pins in their navigation order. */
export async function readSidebarItems(userId: string): Promise<SidebarItem[]> {
  const pins = await db.query.sidebarItems.findMany({
    where: { userId },
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  if (pins.length === 0) return [];
  const apps = await db.query.apps.findMany({
    where: { id: { in: [...new Set(pins.map((p) => p.appId))] } },
    columns: { id: true, slug: true, name: true, status: true },
  });
  const appById = new Map(apps.map((app) => [app.id, app]));
  const items: SidebarItem[] = [];
  for (const pin of pins) {
    const app = appById.get(pin.appId);
    if (!app) continue;
    items.push({
      id: pin.id,
      appId: pin.appId,
      appSlug: app.slug,
      label: pin.label || app.name,
      entryHash: pin.entryHash ?? null,
      status: app.status,
    });
  }
  return items;
}

/** The user's navigation: every dashboard and their App pins. */
export async function readWorkspace(userId: string) {
  const [dashboards, pins] = await Promise.all([
    readDashboards(userId),
    readSidebarItems(userId),
  ]);
  return {
    dashboards: dashboards.map((dashboard) => ({
      id: dashboard.id,
      name: dashboard.name,
      description: dashboard.description ?? '',
      pinned: dashboard.pinned,
      autoRefreshSeconds: dashboard.autoRefreshSeconds,
    })),
    appPins: pins
      .filter((pin) => pin.status !== 'archived')
      .map((pin) => ({
        id: pin.id,
        appId: pin.appId,
        appSlug: pin.appSlug,
        label: pin.label,
        entryHash: pin.entryHash ?? '',
      })),
  };
}
