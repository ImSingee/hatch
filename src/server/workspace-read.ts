import { and, asc, eq, sql } from 'drizzle-orm';
import { db, schema, type TX } from '~/db';

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
 * A user who has no dashboard rows yet (a new user) starts with one pinned
 * dashboard: the default one, first in the order they see (the oldest, which
 * the homepage also falls back to). Once they have rows this does nothing,
 * so unpinning it sticks. Concurrent first visits insert the same row once.
 */
export async function pinDefaultDashboardForNewUser(
  database: Pick<TX, 'execute'>,
  userId: string,
): Promise<void> {
  const view = schema.userDashboards;
  await database.execute(sql`
    insert into ${view} (${sql.identifier('user_id')}, ${sql.identifier('dashboard_id')}, ${sql.identifier('pinned')}, ${sql.identifier('sort_order')})
    select ${userId}::text, ${schema.dashboards.id}, true, 0
    from ${schema.dashboards}
    where not exists (select 1 from ${view} where ${view.userId} = ${userId}::text)
    order by ${schema.dashboards.createdAt} asc, ${schema.dashboards.id} asc
    limit 1
    on conflict do nothing
  `);
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
  if (userId) await pinDefaultDashboardForNewUser(db, userId);
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
