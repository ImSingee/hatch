/**
 * Server-only: navigation pins. The Web UI Server Functions and the public
 * PinService both call this module, so the two surfaces cannot drift.
 *
 * Pins are personal: App pins are a user's rows of `sidebar_items` (an App
 * can have several, each with its own label and entry point), and each user's
 * pinned flag and order of the shared dashboards is in `user_dashboards`.
 * Every function acts for one user and never sees another user's pins.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema, type TX } from '~/db';
import {
  cleanEntryHash,
  MAX_ENTRY_HASH_LEN,
  normalizeEntryHash,
} from './apps/sidebar';
import { AppError } from './errors';
import { publishPlatformEvent } from './platform-events';
import { persistSortOrder } from './sort-order';
import {
  pinDefaultDashboardForNewUser,
  readDashboards,
  readSidebarItems,
  readUserDashboards,
  type SidebarItem,
} from './workspace-read';

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: appDeployLock=1 (apps/deploy.ts), 2 (retired
// with Workflows; do not reuse), APP_KV_LOCK_NS=3 (apps/kv.ts),
// DASHBOARDS_LOCK_NS=5 (dashboards.ts).
const SIDEBAR_PIN_LOCK_NS = 4;

/**
 * Serialize one user's pin writes: it keeps the "ensure one pin" check free
 * of duplicates under concurrent calls and makes the max+1 sortOrder safe.
 * Pin writes are rare and per user; contention is nil.
 */
export async function lockUserPins(tx: TX, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${SIDEBAR_PIN_LOCK_NS}, hashtext(${userId}))`,
  );
}

/** The user's next App pin sortOrder: max+1, so deletions never collide. */
export const nextSidebarSortOrder = (userId: string) =>
  sql`(select coalesce(max(${schema.sidebarItems.sortOrder}), -1) + 1 from ${schema.sidebarItems} where ${schema.sidebarItems.userId} = ${userId})`;

/** Tell the user's connected clients to re-read their pins. */
export const pinsChanged = (userId: string) =>
  publishPlatformEvent({ type: 'pins.updated', userId });

export type Pins = {
  /** In navigation order; includes pins of archived Apps. */
  appPins: SidebarItem[];
  /** In the user's dashboard order. */
  dashboards: { id: string; name: string }[];
};

export async function listPins(userId: string): Promise<Pins> {
  const [appPins, dashboards] = await Promise.all([
    readSidebarItems(userId),
    readDashboards(userId),
  ]);
  return {
    appPins,
    dashboards: dashboards
      .filter((dashboard) => dashboard.pinned)
      .map(({ id, name }) => ({ id, name })),
  };
}

async function appPin(userId: string, id: string): Promise<SidebarItem> {
  const pin = (await readSidebarItems(userId)).find((item) => item.id === id);
  if (!pin)
    throw new AppError('Pin not found.', 404, { code: 'shell.pinNotFound' });
  return pin;
}

/**
 * The stored entry point, or a 400 when it is longer than storage keeps:
 * a pin must open exactly the fragment it was given, never a shortened one.
 */
function pinEntryHash(entryHash: string): string | null {
  if (cleanEntryHash(entryHash).length > MAX_ENTRY_HASH_LEN)
    throw new AppError(
      `The entry point is longer than ${MAX_ENTRY_HASH_LEN} characters.`,
      400,
      { code: 'shell.entryPointTooLong', params: { max: MAX_ENTRY_HASH_LEN } },
    );
  return normalizeEntryHash(entryHash);
}

/** Trimmed label, or a 400 when nothing is left. */
function pinLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed)
    throw new AppError('Name cannot be empty.', 400, {
      code: 'shell.pinNameEmpty',
    });
  return trimmed;
}

/**
 * Pin an App for the user, addressed by id or slug. Always adds a pin (an
 * App can be pinned many times) unless `ifAbsent` is set and the user already
 * has a pin of the App, in which case that pin is returned untouched.
 */
export async function pinApp(
  userId: string,
  input: {
    app: string;
    label?: string;
    entryHash?: string;
    ifAbsent?: boolean;
  },
): Promise<{ pin: SidebarItem; created: boolean }> {
  if (
    input.ifAbsent &&
    (input.label !== undefined || input.entryHash !== undefined)
  )
    throw new AppError(
      'A label or entry point cannot be combined with if-absent.',
      400,
    );
  const label = input.label === undefined ? undefined : pinLabel(input.label);
  const entryHash =
    input.entryHash === undefined ? undefined : pinEntryHash(input.entryHash);
  const result = await db.transaction(async (tx) => {
    await lockUserPins(tx, userId);
    const app =
      (await tx.query.apps.findFirst({ where: { id: input.app } })) ??
      (await tx.query.apps.findFirst({ where: { slug: input.app } }));
    if (!app)
      throw new AppError('App not found.', 404, { code: 'shell.appNotFound' });
    if (input.ifAbsent) {
      const existing = await tx.query.sidebarItems.findFirst({
        where: { appId: app.id, userId },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      });
      if (existing) return { id: existing.id, created: false };
    }
    const [row] = await tx
      .insert(schema.sidebarItems)
      .values({
        userId,
        appId: app.id,
        label: label ?? app.name,
        entryHash,
        sortOrder: nextSidebarSortOrder(userId),
      })
      .returning({ id: schema.sidebarItems.id });
    return { id: row.id, created: true };
  });
  if (result.created) pinsChanged(userId);
  return { pin: await appPin(userId, result.id), created: result.created };
}

/**
 * Change a pin's label, its entry point, or both. `entryHash: null` clears
 * the entry point so the pin opens the App root; `undefined` leaves a field
 * unchanged.
 */
export async function updateAppPin(
  userId: string,
  id: string,
  changes: { label?: string; entryHash?: string | null },
): Promise<SidebarItem> {
  if (changes.label === undefined && changes.entryHash === undefined)
    throw new AppError('Nothing to change.', 400);
  const updated = await db
    .update(schema.sidebarItems)
    .set({
      ...(changes.label === undefined
        ? {}
        : { label: pinLabel(changes.label) }),
      ...(changes.entryHash === undefined
        ? {}
        : {
            entryHash:
              changes.entryHash === null
                ? null
                : pinEntryHash(changes.entryHash),
          }),
    })
    .where(
      and(
        eq(schema.sidebarItems.id, id),
        eq(schema.sidebarItems.userId, userId),
      ),
    )
    .returning({ id: schema.sidebarItems.id });
  if (!updated.length)
    throw new AppError('Pin not found.', 404, { code: 'shell.pinNotFound' });
  pinsChanged(userId);
  return appPin(userId, id);
}

/**
 * Remove one of the user's pins by its id, or all their pins of an App (id
 * or slug). Removing what is already gone succeeds with an empty list; an
 * unknown App, or a pin id that is not the user's, is a 404.
 */
export async function unpinApp(
  userId: string,
  target: { pinId: string } | { app: string },
): Promise<string[]> {
  const own = eq(schema.sidebarItems.userId, userId);
  if ('pinId' in target) {
    const removed = await db
      .delete(schema.sidebarItems)
      .where(and(eq(schema.sidebarItems.id, target.pinId), own))
      .returning({ id: schema.sidebarItems.id });
    if (!removed.length)
      throw new AppError('Pin not found.', 404, { code: 'shell.pinNotFound' });
    pinsChanged(userId);
    return removed.map((row) => row.id);
  }
  const app =
    (await db.query.apps.findFirst({
      where: { id: target.app },
      columns: { id: true },
    })) ??
    (await db.query.apps.findFirst({
      where: { slug: target.app },
      columns: { id: true },
    }));
  if (!app)
    throw new AppError('App not found.', 404, { code: 'shell.appNotFound' });
  const removed = await db
    .delete(schema.sidebarItems)
    .where(and(eq(schema.sidebarItems.appId, app.id), own))
    .returning({ id: schema.sidebarItems.id });
  if (removed.length) pinsChanged(userId);
  return removed.map((row) => row.id);
}

/**
 * Put the listed App pins first, in the given order; see `persistSortOrder`
 * for the pins that are not listed. Returns every pin in its new order.
 */
export async function reorderAppPins(
  userId: string,
  pinIds: string[],
): Promise<SidebarItem[]> {
  await persistSortOrder(
    schema.sidebarItems,
    pinIds,
    eq(schema.sidebarItems.userId, userId),
  );
  pinsChanged(userId);
  return readSidebarItems(userId);
}

/**
 * Store the user's whole dashboard order, with each dashboard's pinned flag:
 * once a user changes anything, every dashboard has a row, so the ones a
 * change does not name keep their place. A listed dashboard someone deleted
 * since the order was read is skipped rather than failing the change.
 */
export async function writeDashboardOrder(
  tx: TX,
  userId: string,
  order: { id: string; pinned: boolean }[],
): Promise<void> {
  if (!order.length) return;
  const view = schema.userDashboards;
  const listed = sql.join(
    order.map(
      ({ id, pinned }, position) =>
        sql`(${id}::text, ${pinned}::boolean, ${position}::integer)`,
    ),
    sql`, `,
  );
  // Inserting from the dashboards that still exist, in one statement, keeps
  // the foreign key satisfied however the order went stale. A dashboard being
  // deleted right now is skipped too: the rows written are locked against
  // deletion until this transaction ends, the others are left out.
  await tx.execute(sql`
    with ${sql.identifier('kept')} as (
      select ${schema.dashboards.id} as id, listed.pinned, listed.position
      from (values ${listed}) as listed (id, pinned, position)
      join ${schema.dashboards} on ${schema.dashboards.id} = listed.id
      for key share of ${schema.dashboards} skip locked
    )
    insert into ${view} (${sql.identifier('user_id')}, ${sql.identifier('dashboard_id')}, ${sql.identifier('pinned')}, ${sql.identifier('sort_order')})
    select ${userId}::text, kept.id, kept.pinned, kept.position from ${sql.identifier('kept')} as kept
    on conflict (${sql.identifier('user_id')}, ${sql.identifier('dashboard_id')}) do update set
      ${sql.identifier('pinned')} = excluded.${sql.identifier('pinned')},
      ${sql.identifier('sort_order')} = excluded.${sql.identifier('sort_order')}
  `);
}

/**
 * The user's dashboard order as `writeDashboardOrder` stores it. A new user
 * gets the default dashboard pinned first, as on their first visit.
 */
export async function currentDashboardOrder(tx: TX, userId: string) {
  await pinDefaultDashboardForNewUser(tx, userId);
  return (await readUserDashboards(tx, userId)).map((row) => ({
    id: row.id,
    pinned: row.pinned ?? false,
  }));
}

/**
 * Put the listed dashboards first in the user's order, the rest after them
 * in their current order. Returns every dashboard id in the new order.
 * Rejects duplicate and unknown ids.
 */
export async function reorderDashboards(
  userId: string,
  dashboardIds: string[],
): Promise<string[]> {
  if (new Set(dashboardIds).size !== dashboardIds.length)
    throw new AppError('The same id is listed more than once.', 400);
  const ordered = await db.transaction(async (tx) => {
    await lockUserPins(tx, userId);
    const current = await currentDashboardOrder(tx, userId);
    const byId = new Map(current.map((entry) => [entry.id, entry]));
    const unknown = dashboardIds.filter((id) => !byId.has(id));
    if (unknown.length)
      throw new AppError(`Not found: ${unknown.join(', ')}.`, 404);
    const listed = new Set(dashboardIds);
    const order = [
      ...dashboardIds.map((id) => byId.get(id)!),
      ...current.filter((entry) => !listed.has(entry.id)),
    ];
    await writeDashboardOrder(tx, userId, order);
    return order.map((entry) => entry.id);
  });
  pinsChanged(userId);
  return ordered;
}

/** Pin or unpin a dashboard for the user; it keeps its place in their order. */
export async function setDashboardPinned(
  userId: string,
  id: string,
  pinned: boolean,
): Promise<{ id: string; pinned: boolean }> {
  await db.transaction(async (tx) => {
    await lockUserPins(tx, userId);
    const current = await currentDashboardOrder(tx, userId);
    if (!current.some((entry) => entry.id === id))
      throw new AppError('Dashboard not found.', 404, {
        code: 'shell.dashboardNotFound',
      });
    await writeDashboardOrder(
      tx,
      userId,
      current.map((entry) => (entry.id === id ? { id, pinned } : entry)),
    );
    // Deleted while this change was being made: say so rather than report a
    // pin nobody can see.
    const written = await tx.query.userDashboards.findFirst({
      where: { userId, dashboardId: id },
      columns: { dashboardId: true },
    });
    if (!written)
      throw new AppError('Dashboard not found.', 404, {
        code: 'shell.dashboardNotFound',
      });
  });
  pinsChanged(userId);
  return { id, pinned };
}
