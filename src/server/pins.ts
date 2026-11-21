/**
 * Server-only: navigation pins. The Web UI Server Functions and the public
 * PinService both call this module, so the two surfaces cannot drift.
 *
 * App pins are rows of `sidebar_items` (an App can have several, each with
 * its own label and entry point); Workflows and dashboards carry a `pinned`
 * flag.
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import { normalizeEntryHash } from './apps/sidebar';
import { AppError } from './errors';
import { publishPlatformEvent } from './platform-events';
import { persistSortOrder } from './sort-order';
import {
  readDashboards,
  readSidebarItems,
  type SidebarItem,
} from './workspace-read';

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: appDeployLock=1 (apps/deploy.ts),
// workflowDeployLock=2 (workflows/deploy.ts), APP_KV_LOCK_NS=3
// (apps/kv.ts), DASHBOARDS_LOCK_NS=5 (dashboards.ts).
const SIDEBAR_PIN_LOCK_NS = 4;

/** Next sidebar sortOrder: max+1, so deletions never cause collisions. */
const nextSidebarSortOrder = () =>
  sql`(select coalesce(max(${schema.sidebarItems.sortOrder}), -1) + 1 from ${schema.sidebarItems})`;

/** Tell connected clients to re-read pins; called after every change. */
const pinsChanged = () => publishPlatformEvent({ type: 'pins.updated' });

export type Pins = {
  /** In navigation order; includes pins of archived Apps. */
  appPins: SidebarItem[];
  /** Most recently updated first, as the navigation shows them. */
  workflows: { id: string; slug: string; name: string }[];
  /** In dashboard order. */
  dashboards: { id: string; name: string }[];
};

export async function listPins(): Promise<Pins> {
  const [appPins, workflows, dashboards] = await Promise.all([
    readSidebarItems(),
    db.query.workflows.findMany({
      where: { pinned: true, status: { ne: 'archived' } },
      orderBy: { updatedAt: 'desc' },
      columns: { id: true, slug: true, name: true },
    }),
    readDashboards(),
  ]);
  return {
    appPins,
    workflows,
    dashboards: dashboards
      .filter((dashboard) => dashboard.pinned)
      .map(({ id, name }) => ({ id, name })),
  };
}

async function appPin(id: string): Promise<SidebarItem> {
  const pin = (await readSidebarItems()).find((item) => item.id === id);
  if (!pin) throw new AppError('Pin not found.', 404);
  return pin;
}

/** Trimmed label, or a 400 when nothing is left. */
function pinLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) throw new AppError('Name cannot be empty.', 400);
  return trimmed;
}

/**
 * Pin an App, addressed by id or slug. Always adds a pin (an App can be
 * pinned many times) unless `ifAbsent` is set and the App already has one,
 * in which case that pin is returned untouched.
 */
export async function pinApp(input: {
  app: string;
  label?: string;
  entryHash?: string;
  ifAbsent?: boolean;
}): Promise<{ pin: SidebarItem; created: boolean }> {
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
    input.entryHash === undefined
      ? undefined
      : normalizeEntryHash(input.entryHash);
  // One global sidebar-insert lock (not per-app): it keeps the "ensure one
  // pin" check free of duplicates under concurrent calls AND makes the max+1
  // sortOrder allocation safe across concurrent pins of *different* apps.
  // Pin writes are rare; contention is nil.
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SIDEBAR_PIN_LOCK_NS}, 0)`,
    );
    const app =
      (await tx.query.apps.findFirst({ where: { id: input.app } })) ??
      (await tx.query.apps.findFirst({ where: { slug: input.app } }));
    if (!app) throw new AppError('App not found.', 404);
    if (input.ifAbsent) {
      const existing = await tx.query.sidebarItems.findFirst({
        where: { appId: app.id },
        orderBy: { sortOrder: 'asc', createdAt: 'asc' },
      });
      if (existing) return { id: existing.id, created: false };
    }
    const [row] = await tx
      .insert(schema.sidebarItems)
      .values({
        appId: app.id,
        label: label ?? app.name,
        entryHash,
        sortOrder: nextSidebarSortOrder(),
      })
      .returning({ id: schema.sidebarItems.id });
    return { id: row.id, created: true };
  });
  if (result.created) pinsChanged();
  return { pin: await appPin(result.id), created: result.created };
}

/**
 * Change a pin's label, its entry point, or both. `entryHash: null` clears
 * the entry point so the pin opens the App root; `undefined` leaves a field
 * unchanged.
 */
export async function updateAppPin(
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
                : normalizeEntryHash(changes.entryHash),
          }),
    })
    .where(eq(schema.sidebarItems.id, id))
    .returning({ id: schema.sidebarItems.id });
  if (!updated.length) throw new AppError('Pin not found.', 404);
  pinsChanged();
  return appPin(id);
}

/**
 * Remove one pin by its id, or every pin of an App (id or slug). Removing
 * what is already gone succeeds with an empty list; an unknown App is a 404.
 */
export async function unpinApp(
  target: { pinId: string } | { app: string },
): Promise<string[]> {
  if ('pinId' in target) {
    const removed = await db
      .delete(schema.sidebarItems)
      .where(eq(schema.sidebarItems.id, target.pinId))
      .returning({ id: schema.sidebarItems.id });
    if (!removed.length) throw new AppError('Pin not found.', 404);
    pinsChanged();
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
  if (!app) throw new AppError('App not found.', 404);
  const removed = await db
    .delete(schema.sidebarItems)
    .where(eq(schema.sidebarItems.appId, app.id))
    .returning({ id: schema.sidebarItems.id });
  if (removed.length) pinsChanged();
  return removed.map((row) => row.id);
}

/**
 * Put the listed App pins first, in the given order; see `persistSortOrder`
 * for the pins that are not listed. Returns every pin in its new order.
 */
export async function reorderAppPins(pinIds: string[]): Promise<SidebarItem[]> {
  await persistSortOrder(schema.sidebarItems, pinIds);
  pinsChanged();
  return readSidebarItems();
}

/** Reorder dashboards the same way; returns every dashboard id in order. */
export async function reorderDashboards(
  dashboardIds: string[],
): Promise<string[]> {
  const ordered = await persistSortOrder(schema.dashboards, dashboardIds);
  pinsChanged();
  return ordered;
}

/** Pin or unpin a Workflow, addressed by id or slug. */
export async function setWorkflowPinned(
  workflow: string,
  pinned: boolean,
): Promise<{ id: string; pinned: boolean }> {
  const row =
    (await db.query.workflows.findFirst({
      where: { id: workflow },
      columns: { id: true },
    })) ??
    (await db.query.workflows.findFirst({
      where: { slug: workflow },
      columns: { id: true },
    }));
  if (!row) throw new AppError('Workflow not found.', 404);
  await db
    .update(schema.workflows)
    .set({ pinned })
    .where(eq(schema.workflows.id, row.id));
  pinsChanged();
  return { id: row.id, pinned };
}

export async function setDashboardPinned(
  id: string,
  pinned: boolean,
): Promise<{ id: string; pinned: boolean }> {
  const updated = await db
    .update(schema.dashboards)
    .set({ pinned })
    .where(eq(schema.dashboards.id, id))
    .returning({ id: schema.dashboards.id });
  if (!updated.length) throw new AppError('Dashboard not found.', 404);
  pinsChanged();
  return { id, pinned };
}
