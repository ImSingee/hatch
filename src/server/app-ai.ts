/**
 * Server functions for App AI settings: the default models for Apps
 * (Settings · Providers) and one App's roles and calls (the App manage page).
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
import { idSchema } from './validation';
import {
  type AppAiDefaultsView,
  type AppAiUsageItem,
  type AppAiUsageSummaryRow,
  type AppAiView,
  getAppAiDefaults,
  getAppAiSettings,
  listAppAiUsage,
  setAppAiDefaults,
  setAppAiRoleModel,
  summarizeAppAiUsage,
} from './apps/ai/settings';

export type {
  AiDefaultView,
  AppAiDefaultsView,
  AppAiRoleView,
  AppAiUsageItem,
  AppAiUsageSummaryRow,
  AppAiView,
} from './apps/ai/settings';

export const getAppAiFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppAiView> => getAppAiSettings(id));

export const setAppAiRoleModelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; role: string; model: string | null }) =>
    z
      .object({
        id: idSchema,
        role: z.string().min(1).max(64),
        model: z.string().min(1).max(400).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<AppAiView> =>
    setAppAiRoleModel(data.id, data.role, data.model),
  );

export const getAppAiDefaultsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AppAiDefaultsView> => getAppAiDefaults());

export const setAppAiDefaultsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { chat?: string | null; image?: string | null }) =>
    z
      .object({
        chat: z.string().min(1).max(400).nullable().optional(),
        image: z.string().min(1).max(400).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<AppAiDefaultsView> =>
    setAppAiDefaults(data),
  );

export const listAppAiUsageFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; cursor?: string }) =>
    z
      .object({ id: idSchema, cursor: z.string().min(1).max(64).optional() })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      calls: AppAiUsageItem[];
      nextCursor: string | null;
      totals: AppAiUsageSummaryRow[];
    }> => {
      const [page, totals] = await Promise.all([
        listAppAiUsage(data.id, { limit: 20, cursor: data.cursor }),
        summarizeAppAiUsage(data.id),
      ]);
      return { ...page, totals };
    },
  );
