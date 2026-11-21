/**
 * Server functions for dashboards and the widgets placed on them. The logic
 * lives in `dashboard-service.ts`, which the public DashboardService shares.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { dashboardWidgetKey } from '~/lib/dashboard-widget';
import { authMiddleware } from './auth';
import {
  createDashboard as createDashboardRecord,
  deleteDashboard as deleteDashboardRecord,
  getDashboardData,
  listAvailableWidgets as readAvailableWidgets,
  listDashboards as readDashboards,
  saveDashboardDraft as commitDashboardDraft,
  updateDashboard,
  type DashboardDraftInput,
} from './dashboard-service';
import {
  reorderDashboards as reorderDashboardOrder,
  setDashboardPinned,
} from './pins';
import { idListSchema, idSchema, nameSchema } from './validation';

export type {
  AvailableWidget,
  Dashboard,
  DashboardData,
  DashboardDraftInput,
  DashboardDraftSaveResult,
  DashboardDraftWidget,
  DashboardItem,
} from './dashboard-service';

export const listDashboards = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => readDashboards());

export const createDashboard = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { name: string }) =>
    z.object({ name: nameSchema }).parse(input),
  )
  .handler(({ data }) =>
    createDashboardRecord({ name: data.name.trim() || 'Untitled' }),
  );

export const setDashboardPin = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; pinned: boolean }) =>
    z.object({ id: idSchema, pinned: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    await setDashboardPinned(data.id, data.pinned);
    return { ok: true };
  });

export const renameDashboard = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; name: string }) =>
    z.object({ id: idSchema, name: nameSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    await updateDashboard(data.id, { name: data.name });
    return { ok: true };
  });

export const setDashboardDescription = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; description: string }) =>
    z.object({ id: idSchema, description: z.string().max(4000) }).parse(input),
  )
  .handler(async ({ data }) => {
    await updateDashboard(data.id, { description: data.description });
    return { ok: true };
  });

export const setDashboardAutoRefresh = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; seconds: number }) =>
    z.object({ id: idSchema, seconds: z.number() }).parse(input),
  )
  .handler(async ({ data }) => {
    await updateDashboard(data.id, { autoRefreshSeconds: data.seconds });
    return { ok: true };
  });

export const deleteDashboard = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    await deleteDashboardRecord(id);
    return { ok: true };
  });

export const reorderDashboards = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((orderedIds: string[]) => idListSchema.parse(orderedIds))
  .handler(async ({ data: orderedIds }) => {
    await reorderDashboardOrder(orderedIds);
    return { ok: true };
  });

/** ================== dashboard widgets ================== */

export const getDashboard = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((dashboardId: string) => idSchema.parse(dashboardId))
  .handler(({ data: dashboardId }) => getDashboardData(dashboardId));

export const listAvailableWidgets = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => readAvailableWidgets());

const layoutItemSchema = z.object({
  id: idSchema,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const layoutSchema = z.array(layoutItemSchema).max(1000);

/**
 * Commit the complete editor draft as one transaction. Nothing in edit mode
 * writes before this call, so Cancel remains a purely local operation.
 */
export const saveDashboardDraft = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: DashboardDraftInput) =>
    z
      .object({
        dashboardId: idSchema,
        expectedRevision: z.number().int().nonnegative(),
        removedWidgetIds: idListSchema.refine(
          (ids) => new Set(ids).size === ids.length,
          'Dashboard draft contains duplicate removals.',
        ),
        widgets: z
          .array(
            z.object({
              id: idSchema,
              appId: idSchema,
              widgetId: idSchema,
            }),
          )
          .max(1000)
          .refine(
            (widgets) =>
              new Set(widgets.map((widget) => widget.id)).size ===
              widgets.length,
            'Dashboard draft contains duplicate client ids.',
          )
          .refine(
            (widgets) =>
              new Set(widgets.map(dashboardWidgetKey)).size === widgets.length,
            'Dashboard draft contains duplicate widgets.',
          ),
        layouts: z.object({
          desktop: layoutSchema,
          tablet: layoutSchema,
          mobile: layoutSchema,
        }),
      })
      .refine((draft) => {
        const retainedIds = new Set(draft.widgets.map((widget) => widget.id));
        return draft.removedWidgetIds.every((id) => !retainedIds.has(id));
      }, 'A dashboard widget cannot be retained and removed in the same draft.')
      .parse(input),
  )
  .handler(({ data }) => commitDashboardDraft(data));
