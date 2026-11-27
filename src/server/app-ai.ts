/** Server functions for an App's AI settings (the App manage page). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
import { MAX_AI_BUDGET_USD } from './apps/ai/contract';
import { idSchema } from './validation';
import {
  type AppAiUsageItem,
  type AppAiUsageSummaryRow,
  type AppAiView,
  getAppAiSettings,
  listAppAiUsage,
  setAppAiBudget,
  setAppAiRoleModel,
  summarizeAppAiUsage,
} from './apps/ai/settings';

export type {
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

export const setAppAiBudgetFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; budgetUsd: number | null }) =>
    z
      .object({
        id: idSchema,
        budgetUsd: z.number().min(0).max(MAX_AI_BUDGET_USD).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<AppAiView> =>
    setAppAiBudget(data.id, data.budgetUsd),
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
