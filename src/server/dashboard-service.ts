/**
 * Server-only: dashboards and the widgets placed on them. The Web UI Server
 * Functions and the public DashboardService both call this module, so the two
 * surfaces cannot drift.
 *
 * The layout editor commits a whole draft at once (`saveDashboardDraft`); the
 * single-widget operations read the current state and commit through the same
 * path under the same lock, so both leave the same normalized layouts behind.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { clampRefreshSeconds } from '../../packages/hatch-platform-api/dashboard-refresh';
import { db, schema, type TX } from '~/db';
import {
  DASHBOARD_BREAKPOINT_ORDER,
  DASHBOARD_COLUMNS,
  DASHBOARD_MAX_HEIGHT,
  DASHBOARD_MAX_Y,
  FREEFORM_MIN_HEIGHT,
  FREEFORM_MIN_WIDTH,
  deriveDashboardLayouts,
  fitWidgetSize,
  placeDashboardLayoutItem,
  supportedSizesForBreakpoint,
  type DashboardBreakpoint,
  type DashboardLayoutItem,
  type DashboardLayouts,
  type PersistedDashboardLayouts,
} from '~/lib/dashboard-layout';
import {
  dashboardWidgetIdsToRemove,
  dashboardWidgetKey,
} from '~/lib/dashboard-widget';
import { liveAppManifests } from './apps/access';
import { AppError } from './errors';
import { publishPlatformEvent } from './platform-events';
import { readDashboards, type Dashboard } from './workspace-read';

export type { Dashboard } from './workspace-read';

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: appDeployLock=1 (apps/deploy.ts), 2 (retired
// with Workflows; do not reuse), APP_KV_LOCK_NS=3
// (apps/kv.ts), SIDEBAR_PIN_LOCK_NS=4 (pins.ts), PLATFORM_CONFIG_LOCK_NS=7
// (platform-config.ts).
const DASHBOARDS_LOCK_NS = 5;

export const MAX_DASHBOARD_NAME_LENGTH = 500;
export const MAX_DASHBOARD_DESCRIPTION_LENGTH = 4000;

async function lockDashboard(tx: TX, dashboardId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${DASHBOARDS_LOCK_NS}, hashtext(${dashboardId}))`,
  );
}

/** Tell connected clients to re-read dashboards; called after every change. */
const dashboardsChanged = (dashboardId?: string) =>
  publishPlatformEvent({ type: 'dashboards.updated', dashboardId });

async function dashboard(id: string): Promise<Dashboard> {
  const found = (await readDashboards()).find((item) => item.id === id);
  if (!found)
    throw new AppError('Dashboard not found.', 404, {
      code: 'dashboard.notFound',
    });
  return found;
}

function dashboardName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed)
    throw new AppError('Dashboard name cannot be empty.', 400, {
      code: 'dashboard.nameEmpty',
    });
  if (Array.from(trimmed).length > MAX_DASHBOARD_NAME_LENGTH)
    throw new AppError('Dashboard name is too long.', 400, {
      code: 'dashboard.nameTooLong',
    });
  return trimmed;
}

function dashboardDescription(description: string): string | null {
  const trimmed = description.trim();
  if (Array.from(trimmed).length > MAX_DASHBOARD_DESCRIPTION_LENGTH)
    throw new AppError('Dashboard description is too long.', 400, {
      code: 'dashboard.descriptionTooLong',
    });
  return trimmed || null;
}

export const listDashboards = readDashboards;

/** Create a dashboard at the end of the order; it starts pinned and empty. */
export async function createDashboard(input: {
  name: string;
  description?: string;
}): Promise<Dashboard> {
  const [row] = await db
    .insert(schema.dashboards)
    .values({
      name: dashboardName(input.name),
      description:
        input.description === undefined
          ? null
          : dashboardDescription(input.description),
      pinned: true,
      // Append at the end via max+1, not a row count: counts shrink after
      // deletions and would hand out an order a surviving row already uses.
      sortOrder: sql`(select coalesce(max(${schema.dashboards.sortOrder}), -1) + 1 from ${schema.dashboards})`,
    })
    .returning({ id: schema.dashboards.id });
  dashboardsChanged(row.id);
  return dashboard(row.id);
}

/**
 * Change a dashboard's name, description or auto-refresh interval.
 * `undefined` leaves a field unchanged; an empty description clears it.
 */
export async function updateDashboard(
  id: string,
  changes: {
    name?: string;
    description?: string;
    autoRefreshSeconds?: number;
  },
): Promise<Dashboard> {
  if (
    changes.name === undefined &&
    changes.description === undefined &&
    changes.autoRefreshSeconds === undefined
  )
    throw new AppError('Nothing to change.', 400, {
      code: 'dashboard.nothingToChange',
    });
  const updated = await db
    .update(schema.dashboards)
    .set({
      ...(changes.name === undefined
        ? {}
        : { name: dashboardName(changes.name) }),
      ...(changes.description === undefined
        ? {}
        : { description: dashboardDescription(changes.description) }),
      ...(changes.autoRefreshSeconds === undefined
        ? {}
        : { autoRefresh: clampRefreshSeconds(changes.autoRefreshSeconds) }),
    })
    .where(eq(schema.dashboards.id, id))
    .returning({ id: schema.dashboards.id });
  if (!updated.length)
    throw new AppError('Dashboard not found.', 404, {
      code: 'dashboard.notFound',
    });
  dashboardsChanged(id);
  return dashboard(id);
}

/** Delete a dashboard and its placements. The last dashboard cannot go. */
export async function deleteDashboard(id: string): Promise<void> {
  // Count and delete under one lock: two concurrent deletes could otherwise
  // both see count=2, both pass the check, and leave zero dashboards.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${DASHBOARDS_LOCK_NS}, 0)`,
    );
    const rows = await tx
      .select({ id: schema.dashboards.id })
      .from(schema.dashboards);
    if (!rows.some((row) => row.id === id))
      throw new AppError('Dashboard not found.', 404, {
        code: 'dashboard.notFound',
      });
    if (rows.length <= 1)
      throw new AppError('You must keep at least one dashboard.', 409, {
        code: 'dashboard.lastDashboard',
      });
    await tx.delete(schema.dashboards).where(eq(schema.dashboards.id, id));
  });
  dashboardsChanged(id);
}

/** ================== dashboard widgets ================== */

export type DashboardItem = {
  id: string;
  appId: string;
  appSlug: string;
  appName: string;
  widgetId: string;
  name: string;
  url: string;
  sortOrder: number;
  defaultSize: { w: number; h: number };
  /** Discrete footprints the widget supports; empty means free-form resizing. */
  supportedSizes: { w: number; h: number }[];
};

export type DashboardData = {
  /** Monotonic version of widget membership and all breakpoint layouts. */
  revision: number;
  widgets: DashboardItem[];
  layouts: DashboardLayouts;
};

async function readDashboardData(
  tx: TX,
  dashboardId: string,
): Promise<DashboardData> {
  const rows = await tx
    .select({
      revision: schema.dashboards.editorRevision,
      id: schema.dashboardWidgets.id,
      appId: schema.dashboardWidgets.appId,
      widgetId: schema.dashboardWidgets.widgetId,
      sortOrder: schema.dashboardWidgets.sortOrder,
      breakpoint: schema.dashboardWidgetLayouts.breakpoint,
      x: schema.dashboardWidgetLayouts.x,
      y: schema.dashboardWidgetLayouts.y,
      w: schema.dashboardWidgetLayouts.w,
      h: schema.dashboardWidgetLayouts.h,
    })
    .from(schema.dashboards)
    .leftJoin(
      schema.dashboardWidgets,
      eq(schema.dashboardWidgets.dashboardId, schema.dashboards.id),
    )
    .leftJoin(
      schema.dashboardWidgetLayouts,
      eq(
        schema.dashboardWidgetLayouts.dashboardWidgetId,
        schema.dashboardWidgets.id,
      ),
    )
    .where(eq(schema.dashboards.id, dashboardId))
    .orderBy(
      asc(schema.dashboardWidgets.sortOrder),
      asc(schema.dashboardWidgets.createdAt),
      asc(schema.dashboardWidgetLayouts.breakpoint),
    );
  if (rows.length === 0)
    throw new AppError('Dashboard not found.', 404, {
      code: 'dashboard.notFound',
    });

  const placements: Array<{
    id: string;
    appId: string;
    widgetId: string;
    sortOrder: number;
  }> = [];
  const seenPlacements = new Set<string>();
  for (const row of rows) {
    if (
      row.id === null ||
      row.appId === null ||
      row.widgetId === null ||
      row.sortOrder === null
    )
      continue;
    if (seenPlacements.has(row.id)) continue;
    seenPlacements.add(row.id);
    placements.push({
      id: row.id,
      appId: row.appId,
      widgetId: row.widgetId,
      sortOrder: row.sortOrder,
    });
  }
  // Resolve through the LIVE manifest (non-archived, widgets-capable) so a
  // placement for an archived/retired app is dropped rather than rendered as a
  // permanently failing card — the widget bundle route rejects those too.
  const appIds = [...new Set(placements.map((placement) => placement.appId))];
  const [manifests, apps] = await Promise.all([
    liveAppManifests(appIds, 'widgets', tx),
    appIds.length === 0
      ? Promise.resolve([])
      : tx.query.apps.findMany({
          where: { id: { in: appIds } },
          columns: { id: true, slug: true },
        }),
  ]);
  const appSlugById = new Map(apps.map((app) => [app.id, app.slug]));
  const items: DashboardItem[] = [];
  for (const placement of placements) {
    const manifest = manifests.get(placement.appId);
    const appSlug = appSlugById.get(placement.appId);
    const widget = manifest?.widgets.find((w) => w.id === placement.widgetId);
    if (!manifest || !appSlug || !widget) continue;
    items.push({
      id: placement.id,
      appId: placement.appId,
      appSlug,
      appName: manifest.name,
      widgetId: widget.id,
      name: widget.name,
      url: widget.url,
      sortOrder: placement.sortOrder,
      defaultSize: widget.defaultSize,
      // Deployments made before widget supportedSizes existed have no such
      // field in their stored manifest; default to free-form ([]) for them.
      supportedSizes: widget.supportedSizes ?? [],
    });
  }

  const validIds = new Set(items.map((item) => item.id));
  const persisted: PersistedDashboardLayouts = {};
  for (const row of rows) {
    if (
      row.id === null ||
      !validIds.has(row.id) ||
      row.breakpoint === null ||
      row.x === null ||
      row.y === null ||
      row.w === null ||
      row.h === null
    )
      continue;
    const layout = persisted[row.breakpoint] ?? [];
    layout.push({ id: row.id, x: row.x, y: row.y, w: row.w, h: row.h });
    persisted[row.breakpoint] = layout;
  }

  return {
    revision: rows[0].revision,
    widgets: items,
    layouts: deriveDashboardLayouts(items, persisted),
  };
}

/** One dashboard's widgets and its layout at every breakpoint. */
export async function getDashboardData(
  dashboardId: string,
): Promise<DashboardData> {
  // The lock makes failed-save reconciliation wait for any in-flight commit;
  // the read then sees membership and layouts from one snapshot, so a response
  // can never combine opposite sides of the same transaction.
  return db.transaction(async (tx) => {
    await lockDashboard(tx, dashboardId);
    return readDashboardData(tx, dashboardId);
  });
}

export type AvailableWidget = {
  appId: string;
  appSlug: string;
  appName: string;
  widgetId: string;
  name: string;
  url: string;
  defaultSize: { w: number; h: number };
  supportedSizes: { w: number; h: number }[];
};

/** Every widget a deployed App offers, whether or not it is placed. */
export async function listAvailableWidgets(
  database: Pick<TX, 'query'> = db,
): Promise<AvailableWidget[]> {
  const deployed = await database.query.apps.findMany({
    where: { status: 'deployed' },
    columns: { id: true, slug: true },
  });
  const manifests = await liveAppManifests(
    deployed.map((app) => app.id),
    'widgets',
    database,
  );
  const items: AvailableWidget[] = [];
  for (const app of deployed) {
    const manifest = manifests.get(app.id);
    if (!manifest) continue;
    for (const widget of manifest.widgets) {
      items.push({
        appId: app.id,
        appSlug: app.slug,
        appName: manifest.name,
        widgetId: widget.id,
        name: widget.name,
        url: widget.url,
        defaultSize: widget.defaultSize,
        supportedSizes: widget.supportedSizes ?? [],
      });
    }
  }
  return items;
}

export type DashboardDraftWidget = {
  /** Existing placement id or a client-only id for a newly added widget. */
  id: string;
  appId: string;
  widgetId: string;
};

export type DashboardDraftInput = {
  dashboardId: string;
  expectedRevision: number;
  /** Existing placements the user explicitly removed from the visible draft. */
  removedWidgetIds: string[];
  widgets: DashboardDraftWidget[];
  layouts: DashboardLayouts;
};

export type DashboardDraftSaveResult =
  | { status: 'saved'; data: DashboardData }
  | { status: 'conflict' };

function assertCompleteLayouts(
  widgets: DashboardDraftWidget[],
  layouts: DashboardLayouts,
): void {
  const widgetIds = new Set(widgets.map((widget) => widget.id));
  for (const breakpoint of DASHBOARD_BREAKPOINT_ORDER) {
    const ids = layouts[breakpoint].map((item) => item.id);
    if (
      ids.length !== widgetIds.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !widgetIds.has(id))
    ) {
      throw new AppError(
        `${breakpoint} layout must contain every dashboard widget exactly once.`,
        400,
      );
    }
  }
}

/** Commit a draft inside a transaction that already holds the dashboard lock. */
async function commitDraft(
  tx: TX,
  data: DashboardDraftInput,
): Promise<DashboardDraftSaveResult> {
  const [current] = await tx
    .select({
      id: schema.dashboards.id,
      editorRevision: schema.dashboards.editorRevision,
    })
    .from(schema.dashboards)
    .where(eq(schema.dashboards.id, data.dashboardId));
  if (!current)
    throw new AppError('Dashboard not found.', 404, {
      code: 'dashboard.notFound',
    });
  if (current.editorRevision !== data.expectedRevision) {
    return { status: 'conflict' };
  }

  assertCompleteLayouts(data.widgets, data.layouts);

  const appIds = [...new Set(data.widgets.map((widget) => widget.appId))];
  const [manifests, apps] = await Promise.all([
    liveAppManifests(appIds, 'widgets', tx),
    appIds.length === 0
      ? Promise.resolve([])
      : tx.query.apps.findMany({
          where: { id: { in: appIds } },
          columns: { id: true, slug: true },
        }),
  ]);
  const appSlugById = new Map(apps.map((app) => [app.id, app.slug]));
  const widgetInfo = new Map<string, Omit<DashboardItem, 'id' | 'sortOrder'>>();
  for (const draftWidget of data.widgets) {
    const manifest = manifests.get(draftWidget.appId);
    const appSlug = appSlugById.get(draftWidget.appId);
    const widget = manifest?.widgets.find(
      (candidate) => candidate.id === draftWidget.widgetId,
    );
    if (!manifest || !appSlug || !widget) {
      throw new AppError('A dashboard widget is no longer available.', 409, {
        code: 'dashboard.widgetUnavailable',
      });
    }
    widgetInfo.set(draftWidget.id, {
      appId: draftWidget.appId,
      appSlug,
      appName: manifest.name,
      widgetId: draftWidget.widgetId,
      name: widget.name,
      url: widget.url,
      defaultSize: widget.defaultSize,
      supportedSizes: widget.supportedSizes ?? [],
    });
  }

  // Reuse the read-time normalization on untrusted input: clamp coordinates,
  // enforce declared widget footprints, and repair collisions deterministically.
  const normalizedLayouts = deriveDashboardLayouts(
    data.widgets.map((widget, sortOrder) => {
      const info = widgetInfo.get(widget.id);
      if (!info) throw new Error('Dashboard widget metadata is missing.');
      return {
        id: widget.id,
        sortOrder,
        defaultSize: info.defaultSize,
        supportedSizes: info.supportedSizes,
      };
    }),
    data.layouts,
  );

  const existing = await tx
    .select({
      id: schema.dashboardWidgets.id,
      appId: schema.dashboardWidgets.appId,
      widgetId: schema.dashboardWidgets.widgetId,
    })
    .from(schema.dashboardWidgets)
    .where(eq(schema.dashboardWidgets.dashboardId, data.dashboardId));
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const existingByKey = new Map(
    existing.map((row) => [dashboardWidgetKey(row), row]),
  );
  const clientToActual = new Map<string, string>();

  for (const [sortOrder, draftWidget] of data.widgets.entries()) {
    const byId = existingById.get(draftWidget.id);
    if (
      byId &&
      (byId.appId !== draftWidget.appId ||
        byId.widgetId !== draftWidget.widgetId)
    ) {
      throw new AppError('Dashboard widget identity cannot be changed.', 400);
    }

    let placement = byId ?? existingByKey.get(dashboardWidgetKey(draftWidget));
    if (!placement) {
      [placement] = await tx
        .insert(schema.dashboardWidgets)
        .values({
          dashboardId: data.dashboardId,
          appId: draftWidget.appId,
          widgetId: draftWidget.widgetId,
          sortOrder,
        })
        .returning({
          id: schema.dashboardWidgets.id,
          appId: schema.dashboardWidgets.appId,
          widgetId: schema.dashboardWidgets.widgetId,
        });
    }
    if (!placement) throw new Error('Could not save dashboard widget.');
    clientToActual.set(draftWidget.id, placement.id);
  }

  // Missing rows are not removals: reads intentionally hide placements whose
  // app/widget is temporarily unavailable. Delete only placement ids that
  // were explicitly removed.
  const retainedIds = [...clientToActual.values()];
  const removedWidgetIds = dashboardWidgetIdsToRemove(
    data.removedWidgetIds,
    retainedIds,
  );
  if (removedWidgetIds.length > 0) {
    await tx
      .delete(schema.dashboardWidgets)
      .where(
        and(
          eq(schema.dashboardWidgets.dashboardId, data.dashboardId),
          inArray(schema.dashboardWidgets.id, removedWidgetIds),
        ),
      );
  }

  if (retainedIds.length > 0) {
    await tx
      .delete(schema.dashboardWidgetLayouts)
      .where(
        inArray(schema.dashboardWidgetLayouts.dashboardWidgetId, retainedIds),
      );
  }

  const layoutRows = DASHBOARD_BREAKPOINT_ORDER.flatMap((breakpoint) =>
    normalizedLayouts[breakpoint].map((item) => ({
      dashboardWidgetId: clientToActual.get(item.id) as string,
      breakpoint,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    })),
  );
  if (layoutRows.length > 0) {
    await tx.insert(schema.dashboardWidgetLayouts).values(layoutRows);
  }

  for (const [sortOrder, item] of normalizedLayouts.desktop.entries()) {
    const id = clientToActual.get(item.id);
    if (!id) throw new Error('Dashboard widget id mapping is missing.');
    await tx
      .update(schema.dashboardWidgets)
      .set({ sortOrder })
      .where(eq(schema.dashboardWidgets.id, id));
  }

  const revision = current.editorRevision + 1;
  await tx
    .update(schema.dashboards)
    .set({ editorRevision: revision, updatedAt: new Date() })
    .where(eq(schema.dashboards.id, data.dashboardId));

  const layouts = Object.fromEntries(
    DASHBOARD_BREAKPOINT_ORDER.map((breakpoint) => [
      breakpoint,
      normalizedLayouts[breakpoint].map((item): DashboardLayoutItem => ({
        ...item,
        id: clientToActual.get(item.id) as string,
      })),
    ]),
  ) as DashboardLayouts;
  const desktopOrder = new Map(
    normalizedLayouts.desktop.map((item, index) => [item.id, index]),
  );
  const widgets = data.widgets
    .map((widget): DashboardItem => {
      const info = widgetInfo.get(widget.id);
      const id = clientToActual.get(widget.id);
      if (!info || !id) throw new Error('Saved dashboard data is incomplete.');
      return { id, ...info, sortOrder: desktopOrder.get(widget.id) ?? 0 };
    })
    .sort((left, right) => left.sortOrder - right.sortOrder);

  return { status: 'saved', data: { revision, widgets, layouts } };
}

/**
 * Commit the complete editor draft as one transaction. Nothing in edit mode
 * writes before this call, so Cancel remains a purely local operation.
 */
export async function saveDashboardDraft(
  data: DashboardDraftInput,
): Promise<DashboardDraftSaveResult> {
  const result = await db.transaction(async (tx) => {
    // Acquire the dashboard fence before any asynchronous preparation. A
    // reconciliation read taking the same lock cannot pass a save that is
    // still validating manifests, normalizing layouts, or committing rows.
    await lockDashboard(tx, data.dashboardId);
    return commitDraft(tx, data);
  });
  if (result.status === 'saved') dashboardsChanged(data.dashboardId);
  return result;
}

/**
 * Apply one change to the current state of a dashboard. The read and the
 * commit share the lock, so the revision check cannot fail here.
 */
async function editDashboard(
  dashboardId: string,
  edit: (
    current: DashboardData,
    tx: TX,
  ) => Promise<{
    widgets: DashboardDraftWidget[];
    layouts: DashboardLayouts;
    removedWidgetIds?: string[];
  }>,
): Promise<DashboardData> {
  const data = await db.transaction(async (tx) => {
    await lockDashboard(tx, dashboardId);
    const current = await readDashboardData(tx, dashboardId);
    const next = await edit(current, tx);
    const result = await commitDraft(tx, {
      dashboardId,
      expectedRevision: current.revision,
      removedWidgetIds: next.removedWidgetIds ?? [],
      widgets: next.widgets,
      layouts: next.layouts,
    });
    if (result.status !== 'saved')
      throw new AppError('Dashboard changed while it was being edited.', 409, {
        code: 'dashboard.changedWhileEditing',
      });
    return result.data;
  });
  dashboardsChanged(dashboardId);
  return data;
}

const draftWidgets = (current: DashboardData): DashboardDraftWidget[] =>
  current.widgets.map(({ id, appId, widgetId }) => ({ id, appId, widgetId }));

export type WidgetPosition = {
  breakpoint: DashboardBreakpoint;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

const sizeText = (size: { w: number; h: number }) => `${size.w}x${size.h}`;

/**
 * Check a requested footprint and position against the grid and the widget's
 * declared sizes. Unlike the editor, which snaps a drag to the nearest valid
 * value, a caller that names numbers gets them or an error naming the choices.
 */
function checkedGeometry(
  widget: Pick<DashboardItem, 'supportedSizes'>,
  breakpoint: DashboardBreakpoint,
  requested: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  const columns = DASHBOARD_COLUMNS[breakpoint];
  for (const [name, value] of Object.entries(requested))
    if (!Number.isInteger(value) || value < 0)
      throw new AppError(`${name} must be a whole number, 0 or more.`, 400);
  const supported = supportedSizesForBreakpoint(
    widget.supportedSizes,
    breakpoint,
  );
  if (supported.length > 0) {
    if (
      !supported.some(
        (size) => size.w === requested.w && size.h === requested.h,
      )
    )
      throw new AppError(
        `This widget supports only these sizes on ${breakpoint}: ${supported.map(sizeText).join(', ')}.`,
        400,
      );
  } else {
    const minWidth = Math.min(FREEFORM_MIN_WIDTH, columns);
    if (requested.w < minWidth || requested.w > columns)
      throw new AppError(
        `Width must be between ${minWidth} and ${columns} on ${breakpoint}.`,
        400,
      );
    if (requested.h < FREEFORM_MIN_HEIGHT || requested.h > DASHBOARD_MAX_HEIGHT)
      throw new AppError(
        `Height must be between ${FREEFORM_MIN_HEIGHT} and ${DASHBOARD_MAX_HEIGHT}.`,
        400,
      );
  }
  if (requested.x + requested.w > columns)
    throw new AppError(
      `x plus width must not exceed the ${columns} columns of ${breakpoint}.`,
      400,
    );
  if (requested.y > DASHBOARD_MAX_Y)
    throw new AppError(`y must not exceed ${DASHBOARD_MAX_Y}.`, 400);
  return requested;
}

const layoutBottom = (layout: DashboardLayoutItem[]) =>
  layout.reduce((value, item) => Math.max(value, item.y + item.h), 0);

/**
 * Place a widget of a deployed App (id or slug) on a dashboard. Without a
 * position it goes below everything else at its default size, as the editor
 * adds it; a position applies to one breakpoint and the others follow from it.
 */
export async function addDashboardWidget(
  dashboardId: string,
  input: { app: string; widgetId: string; position?: WidgetPosition },
): Promise<{ data: DashboardData; placementId: string }> {
  let key = '';
  const data = await editDashboard(dashboardId, async (current, tx) => {
    const app =
      (await tx.query.apps.findFirst({
        where: { id: input.app },
        columns: { id: true },
      })) ??
      (await tx.query.apps.findFirst({
        where: { slug: input.app },
        columns: { id: true },
      }));
    if (!app)
      throw new AppError('App not found.', 404, {
        code: 'dashboard.appNotFound',
      });
    const widget = (await listAvailableWidgets(tx)).find(
      (candidate) =>
        candidate.appId === app.id && candidate.widgetId === input.widgetId,
    );
    if (!widget)
      throw new AppError(
        'Widget not found: the App is not deployed or has no widget with this id.',
        404,
        { code: 'dashboard.widgetUnknown' },
      );
    key = dashboardWidgetKey(widget);
    const placed = current.widgets.find(
      (item) => dashboardWidgetKey(item) === key,
    );
    if (placed)
      throw new AppError(
        `This widget is already on the dashboard (placement ${placed.id}).`,
        409,
        {
          code: 'dashboard.widgetAlreadyPlaced',
          params: { placementId: placed.id },
        },
      );

    const id = `draft:${crypto.randomUUID()}`;
    const breakpoint = input.position?.breakpoint ?? 'desktop';
    const fallback = fitWidgetSize(widget, widget.defaultSize, breakpoint);
    const geometry = checkedGeometry(widget, breakpoint, {
      x: input.position?.x ?? 0,
      y: input.position?.y ?? layoutBottom(current.layouts[breakpoint]),
      w: input.position?.w ?? fallback.w,
      h: input.position?.h ?? fallback.h,
    });
    const widgets = [
      ...draftWidgets(current),
      { id, appId: widget.appId, widgetId: widget.widgetId },
    ];
    const persisted: PersistedDashboardLayouts = {
      ...current.layouts,
      [breakpoint]: placeDashboardLayoutItem(current.layouts[breakpoint], {
        id,
        ...geometry,
      }),
    };
    return {
      widgets,
      // The breakpoints that were not given a position derive one from the
      // next wider layout, exactly as they do for the editor.
      layouts: deriveDashboardLayouts(
        [
          ...current.widgets,
          {
            id,
            sortOrder: current.widgets.length,
            defaultSize: widget.defaultSize,
            supportedSizes: widget.supportedSizes,
          },
        ],
        persisted,
      ),
    };
  });
  const placement = data.widgets.find(
    (item) => dashboardWidgetKey(item) === key,
  );
  if (!placement) throw new Error('Added dashboard widget is missing.');
  return { data, placementId: placement.id };
}

/**
 * Move or resize one placed widget at one breakpoint. Omitted numbers keep
 * their current value. Widgets it lands on move down, and rows close up, as
 * they do when a widget is dropped in the editor.
 */
export async function setDashboardWidgetLayout(
  dashboardId: string,
  placementId: string,
  position: WidgetPosition,
): Promise<DashboardData> {
  if (
    position.x === undefined &&
    position.y === undefined &&
    position.w === undefined &&
    position.h === undefined
  )
    throw new AppError('Nothing to change.', 400, {
      code: 'dashboard.nothingToChange',
    });
  return editDashboard(dashboardId, async (current) => {
    const widget = current.widgets.find((item) => item.id === placementId);
    const layout = current.layouts[position.breakpoint];
    const item = layout.find((candidate) => candidate.id === placementId);
    if (!widget || !item)
      throw new AppError('Widget not found on this dashboard.', 404, {
        code: 'dashboard.widgetNotPlaced',
      });
    const geometry = checkedGeometry(widget, position.breakpoint, {
      x: position.x ?? item.x,
      y: position.y ?? item.y,
      w: position.w ?? item.w,
      h: position.h ?? item.h,
    });
    return {
      widgets: draftWidgets(current),
      layouts: {
        ...current.layouts,
        [position.breakpoint]: placeDashboardLayoutItem(layout, {
          id: placementId,
          ...geometry,
        }),
      },
    };
  });
}

/** Take one placed widget off a dashboard. The App is not affected. */
export async function removeDashboardWidget(
  dashboardId: string,
  placementId: string,
): Promise<DashboardData> {
  return editDashboard(dashboardId, async (current, tx) => {
    // Look the placement up directly: one whose App is unavailable is hidden
    // from the read but can still be removed by id.
    const [placement] = await tx
      .select({ id: schema.dashboardWidgets.id })
      .from(schema.dashboardWidgets)
      .where(
        and(
          eq(schema.dashboardWidgets.dashboardId, dashboardId),
          eq(schema.dashboardWidgets.id, placementId),
        ),
      );
    if (!placement)
      throw new AppError('Widget not found on this dashboard.', 404, {
        code: 'dashboard.widgetNotPlaced',
      });
    const keep = (item: { id: string }) => item.id !== placementId;
    return {
      widgets: draftWidgets(current).filter(keep),
      layouts: {
        desktop: current.layouts.desktop.filter(keep),
        tablet: current.layouts.tablet.filter(keep),
        mobile: current.layouts.mobile.filter(keep),
      },
      removedWidgetIds: [placementId],
    };
  });
}
