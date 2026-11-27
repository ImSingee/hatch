/**
 * Server-only: the owner's AI settings for one App — which model serves each
 * declared role, the monthly budget, and the usage record. The Web UI Server
 * Functions and the public AppService RPCs both call these.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AppAiCallKind, AppAiCallStatus } from '~/db/schema';
import type { AiRole, NormalizedManifest } from '~server/apps/manifest';
import { AppError } from '~server/errors';
import { MAX_AI_BUDGET_USD } from './contract';
import { listAiModelOptions, type AiModelOption } from './models';
import { monthStart } from './usage';

export type AppAiRoleView = {
  name: string;
  kind: AiRole['kind'];
  description: string;
  needs: NonNullable<AiRole['needs']>;
  /** The model calls use now; null when none of this kind is configured. */
  model: AiModelOption | null;
  /** True when the owner picked the model; false when it is the default. */
  bound: boolean;
  /** True when the picked model is disabled, so calls fail until it is changed. */
  unavailable: boolean;
  /** Declared needs the effective model does not offer (only `reasoning` is known). */
  missingNeeds: NonNullable<AiRole['needs']>;
};

export type AppAiView = {
  appId: string;
  /** False when the live deployment declares no AI roles. */
  available: boolean;
  roles: AppAiRoleView[];
  /** Monthly cap in US dollars; null means no cap. */
  budgetUsd: number | null;
  /** Estimated spend since `monthStart`. */
  monthSpendUsd: number;
  /** Calls this month whose model has no price, so the spend is a floor. */
  monthUnpricedCalls: number;
  monthStart: string;
  /** Models each role kind may be set to. */
  models: { chat: AiModelOption[]; image: AiModelOption[] };
};

async function loadApp(appId: string) {
  const app = await db.query.apps.findFirst({
    where: { id: appId },
    columns: {
      id: true,
      currentDeploymentId: true,
      aiMonthlyBudgetMicros: true,
    },
  });
  if (!app) throw new AppError('App not found.', 404);
  const deployment = app.currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: { id: app.currentDeploymentId },
        columns: { manifestNormalized: true },
      })
    : undefined;
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  return { app, roles: manifest?.ai?.roles ?? [] };
}

async function monthTotals(appId: string) {
  const [row] = await db
    .select({
      micros: sql<string>`coalesce(sum(${schema.appAiUsage.costMicros}), 0)`,
      unpriced: sql<string>`count(*) filter (where not ${schema.appAiUsage.costKnown})`,
    })
    .from(schema.appAiUsage)
    .where(
      and(
        eq(schema.appAiUsage.appId, appId),
        gte(schema.appAiUsage.createdAt, monthStart()),
      ),
    );
  return {
    spendUsd: Number(row?.micros ?? 0) / 1e6,
    unpriced: Number(row?.unpriced ?? 0),
  };
}

export async function getAppAiSettings(appId: string): Promise<AppAiView> {
  const { app, roles } = await loadApp(appId);
  const [models, bindings, totals] = await Promise.all([
    listAiModelOptions(),
    db.query.appAiRoleBindings.findMany({ where: { appId } }),
    monthTotals(appId),
  ]);
  const boundRows = bindings.length
    ? await db.query.agentModels.findMany({
        where: { id: { in: bindings.map((binding) => binding.modelRowId) } },
        columns: { id: true, providerId: true, modelId: true, name: true },
      })
    : [];
  const boundProviders = boundRows.length
    ? await db.query.agentProviders.findMany({
        where: { id: { in: boundRows.map((row) => row.providerId) } },
        columns: { id: true, name: true },
      })
    : [];

  const views = roles.map((role): AppAiRoleView => {
    const options = models[role.kind];
    const binding = bindings.find((entry) => entry.role === role.name);
    let model: AiModelOption | null = options[0] ?? null;
    let unavailable = false;
    if (binding) {
      const usable = options.find((option) => option.id === binding.modelRowId);
      if (usable) {
        model = usable;
      } else {
        const row = boundRows.find((entry) => entry.id === binding.modelRowId);
        const providerName =
          boundProviders.find((entry) => entry.id === row?.providerId)?.name ??
          '';
        unavailable = true;
        model = row
          ? {
              id: row.id,
              providerName,
              modelId: row.modelId,
              name: row.name,
              ref: `${providerName}/${row.modelId}`,
              reasoning: false,
            }
          : null;
      }
    }
    const needs = role.needs ?? [];
    const missingNeeds =
      model && role.kind === 'chat' && !model.reasoning
        ? needs.filter((need) => need === 'reasoning')
        : [];
    return {
      name: role.name,
      kind: role.kind,
      description: role.description,
      needs,
      model,
      bound: Boolean(binding),
      unavailable,
      missingNeeds,
    };
  });

  return {
    appId: app.id,
    available: roles.length > 0,
    roles: views,
    budgetUsd:
      app.aiMonthlyBudgetMicros === null
        ? null
        : app.aiMonthlyBudgetMicros / 1e6,
    monthSpendUsd: totals.spendUsd,
    monthUnpricedCalls: totals.unpriced,
    monthStart: monthStart().toISOString(),
    models,
  };
}

/**
 * Pick the model for one declared role, or clear the pick (`null`) so the
 * role uses the default. `model` is a model id from the options or a
 * `<provider name>/<model id>` reference.
 */
export async function setAppAiRoleModel(
  appId: string,
  roleName: string,
  model: string | null,
): Promise<AppAiView> {
  const { roles } = await loadApp(appId);
  const role = roles.find((entry) => entry.name === roleName);
  if (!role)
    throw new AppError(
      `AI role "${roleName}" is not declared in the App's live manifest.`,
      404,
      { code: 'app.aiRoleNotFound', params: { role: roleName } },
    );
  if (model === null) {
    await db
      .delete(schema.appAiRoleBindings)
      .where(
        and(
          eq(schema.appAiRoleBindings.appId, appId),
          eq(schema.appAiRoleBindings.role, roleName),
        ),
      );
    return getAppAiSettings(appId);
  }
  const options = (await listAiModelOptions())[role.kind];
  const matches = options.filter(
    (option) => option.id === model || option.ref === model,
  );
  if (matches.length !== 1)
    throw new AppError(
      matches.length
        ? `Model "${model}" matches several ${role.kind} models; pass its id instead.`
        : `No usable ${role.kind} model matches "${model}".`,
      400,
      { code: 'app.aiModelNotFound', params: { model, kind: role.kind } },
    );
  await db
    .insert(schema.appAiRoleBindings)
    .values({ appId, role: roleName, modelRowId: matches[0].id })
    .onConflictDoUpdate({
      target: [schema.appAiRoleBindings.appId, schema.appAiRoleBindings.role],
      set: { modelRowId: matches[0].id, updatedAt: new Date() },
    });
  return getAppAiSettings(appId);
}

/** Set the monthly budget in US dollars, or remove the cap with `null`. */
export async function setAppAiBudget(
  appId: string,
  budgetUsd: number | null,
): Promise<AppAiView> {
  if (
    budgetUsd !== null &&
    (!Number.isFinite(budgetUsd) ||
      budgetUsd < 0 ||
      budgetUsd > MAX_AI_BUDGET_USD)
  )
    throw new AppError(
      `The monthly AI budget must be 0 to ${MAX_AI_BUDGET_USD} USD.`,
      400,
      { code: 'app.aiBudgetInvalid' },
    );
  const updated = await db
    .update(schema.apps)
    .set({
      aiMonthlyBudgetMicros:
        budgetUsd === null ? null : Math.round(budgetUsd * 1e6),
    })
    .where(eq(schema.apps.id, appId))
    .returning({ id: schema.apps.id });
  if (!updated.length) throw new AppError('App not found.', 404);
  return getAppAiSettings(appId);
}

export type AppAiUsageItem = {
  id: string;
  createdAt: string;
  role: string;
  kind: AppAiCallKind;
  providerName: string;
  modelId: string;
  status: AppAiCallStatus;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  images: number;
  /** Null when the model has no price. */
  costUsd: number | null;
  durationMs: number;
};

export type AppAiUsageSummaryRow = {
  role: string;
  providerName: string;
  modelId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  images: number;
  costUsd: number;
  unpricedCalls: number;
};

/** Newest calls first; `cursor` is the last id of the previous page. */
export async function listAppAiUsage(
  appId: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ calls: AppAiUsageItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const rows = await db
    .select()
    .from(schema.appAiUsage)
    .where(
      and(
        eq(schema.appAiUsage.appId, appId),
        options.cursor ? lt(schema.appAiUsage.id, options.cursor) : undefined,
      ),
    )
    .orderBy(desc(schema.appAiUsage.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    calls: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      role: row.role,
      kind: row.kind,
      providerName: row.providerName,
      modelId: row.modelId,
      status: row.status,
      errorCode: row.errorCode,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      images: row.images,
      costUsd: row.costKnown ? row.costMicros / 1e6 : null,
      durationMs: row.durationMs,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** This month's calls grouped by role and model, most expensive first. */
export async function summarizeAppAiUsage(
  appId: string,
): Promise<AppAiUsageSummaryRow[]> {
  const t = schema.appAiUsage;
  const rows = await db
    .select({
      role: t.role,
      providerName: t.providerName,
      modelId: t.modelId,
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${t.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${t.outputTokens}), 0)`,
      images: sql<string>`coalesce(sum(${t.images}), 0)`,
      costMicros: sql<string>`coalesce(sum(${t.costMicros}), 0)`,
      unpriced: sql<string>`count(*) filter (where not ${t.costKnown})`,
    })
    .from(t)
    .where(and(eq(t.appId, appId), gte(t.createdAt, monthStart())))
    .groupBy(t.role, t.providerName, t.modelId);
  return rows
    .map((row) => ({
      role: row.role,
      providerName: row.providerName,
      modelId: row.modelId,
      calls: Number(row.calls),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      images: Number(row.images),
      costUsd: Number(row.costMicros) / 1e6,
      unpricedCalls: Number(row.unpriced),
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}
