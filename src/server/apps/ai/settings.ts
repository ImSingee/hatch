/**
 * Server-only: the owner's AI settings — the platform default models for
 * Apps, which model serves each role an App declares, and the record of the
 * App's AI calls. The Web UI Server Functions and the public AppService RPCs
 * both call these.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AppAiCallKind, AppAiCallStatus } from '~/db/schema';
import type { AiRole, NormalizedManifest } from '~server/apps/manifest';
import { AppError } from '~server/errors';
import { updatePlatformConfig } from '~server/platform-config';
import {
  defaultModelRowId,
  listAiModelOptions,
  type AiDefaultSource,
  type AiModelOption,
  type AiRoleKind,
} from './models';
import { monthStart } from './usage';

type Options = Record<AiRoleKind, AiModelOption[]>;

/** Describe a model row for a view, also when it is no longer usable. */
async function describeModel(
  id: string,
  options: AiModelOption[],
): Promise<{ model: AiModelOption | null; unavailable: boolean }> {
  const usable = options.find((option) => option.id === id);
  if (usable) return { model: usable, unavailable: false };
  const row = await db.query.agentModels.findFirst({
    where: { id },
    columns: { id: true, providerId: true, modelId: true, name: true },
  });
  if (!row) return { model: null, unavailable: true };
  const provider = await db.query.agentProviders.findFirst({
    where: { id: row.providerId },
    columns: { name: true },
  });
  const providerName = provider?.name ?? '';
  return {
    model: {
      id: row.id,
      providerName,
      modelId: row.modelId,
      name: row.name,
      ref: `${providerName}/${row.modelId}`,
      reasoning: false,
    },
    unavailable: true,
  };
}

/** Resolve a model id or `<provider>/<model>` ref to one usable option. */
function matchModel(options: Options, kind: AiRoleKind, model: string) {
  const matches = options[kind].filter(
    (option) => option.id === model || option.ref === model,
  );
  if (matches.length !== 1)
    throw new AppError(
      matches.length
        ? `Model "${model}" matches several ${kind} models; pass its id instead.`
        : `No usable ${kind} model matches "${model}".`,
      400,
      { code: 'app.aiModelNotFound', params: { model, kind } },
    );
  return matches[0];
}

/** ================== platform defaults ================== */

export type AiDefaultView = {
  /** The model unpicked roles of this kind use now; null when none exists. */
  model: AiModelOption | null;
  /** `setting` when the owner chose it; `order` when it is the first model. */
  source: AiDefaultSource;
  /** True when the chosen default is disabled, so those calls fail. */
  unavailable: boolean;
};

export type AppAiDefaultsView = {
  chat: AiDefaultView;
  image: AiDefaultView;
  /** Models each kind may be set to. */
  models: Options;
};

async function defaultView(
  kind: AiRoleKind,
  options: Options,
): Promise<AiDefaultView> {
  const { id, source } = await defaultModelRowId(kind, options);
  if (!id) return { model: null, source, unavailable: false };
  const { model, unavailable } = await describeModel(id, options[kind]);
  return { model, source, unavailable };
}

export async function getAppAiDefaults(): Promise<AppAiDefaultsView> {
  const models = await listAiModelOptions();
  const [chat, image] = await Promise.all([
    defaultView('chat', models),
    defaultView('image', models),
  ]);
  return { chat, image, models };
}

/**
 * Set or clear the default chat and image models for Apps. `undefined` leaves
 * a kind unchanged; `null` clears it so the first usable model applies.
 * `chat` / `image` take a model id or a `<provider name>/<model id>` ref.
 */
export async function setAppAiDefaults(change: {
  chat?: string | null;
  image?: string | null;
}): Promise<AppAiDefaultsView> {
  const options = await listAiModelOptions();
  const pick = (kind: AiRoleKind, value: string | null | undefined) =>
    value == null ? value : matchModel(options, kind, value).id;
  const chatModelId = pick('chat', change.chat);
  const imageModelId = pick('image', change.image);
  await updatePlatformConfig('apps.aiDefaults', (current) => ({
    chatModelId: chatModelId === undefined ? current.chatModelId : chatModelId,
    imageModelId:
      imageModelId === undefined ? current.imageModelId : imageModelId,
  }));
  return getAppAiDefaults();
}

/** ================== per-App roles ================== */

export type AppAiRoleView = {
  name: string;
  kind: AiRoleKind;
  description: string;
  needs: NonNullable<AiRole['needs']>;
  /** The model calls use now; null when none of this kind is configured. */
  model: AiModelOption | null;
  /** True when the owner picked the model for this role. */
  bound: boolean;
  /** Where an unpicked role's model comes from; null when bound. */
  defaultSource: AiDefaultSource | null;
  /** True when the model is disabled, so calls fail until it is changed. */
  unavailable: boolean;
  /** Declared needs the effective model does not offer (only `reasoning` is known). */
  missingNeeds: NonNullable<AiRole['needs']>;
};

export type AppAiView = {
  appId: string;
  /** False when the live deployment declares no AI roles. */
  available: boolean;
  roles: AppAiRoleView[];
  /** Models each role kind may be set to. */
  models: Options;
};

async function loadRoles(appId: string): Promise<AiRole[]> {
  const app = await db.query.apps.findFirst({
    where: { id: appId },
    columns: { id: true, currentDeploymentId: true },
  });
  if (!app) throw new AppError('App not found.', 404);
  const deployment = app.currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: { id: app.currentDeploymentId },
        columns: { manifestNormalized: true },
      })
    : undefined;
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  return manifest?.ai?.roles ?? [];
}

export async function getAppAiSettings(appId: string): Promise<AppAiView> {
  const roles = await loadRoles(appId);
  const [models, bindings] = await Promise.all([
    listAiModelOptions(),
    db.query.appAiRoleBindings.findMany({ where: { appId } }),
  ]);
  const defaults = {
    chat: await defaultView('chat', models),
    image: await defaultView('image', models),
  };

  const views = await Promise.all(
    roles.map(async (role): Promise<AppAiRoleView> => {
      const binding = bindings.find((entry) => entry.role === role.name);
      const effective = binding
        ? await describeModel(binding.modelRowId, models[role.kind])
        : defaults[role.kind];
      const needs = role.needs ?? [];
      return {
        name: role.name,
        kind: role.kind,
        description: role.description,
        needs,
        model: effective.model,
        bound: Boolean(binding),
        defaultSource: binding ? null : defaults[role.kind].source,
        unavailable: effective.unavailable,
        missingNeeds:
          effective.model && role.kind === 'chat' && !effective.model.reasoning
            ? needs.filter((need) => need === 'reasoning')
            : [],
      };
    }),
  );

  return { appId, available: roles.length > 0, roles: views, models };
}

/**
 * Pick the model for one declared role, or clear the pick (`null`) so the
 * role uses the default model for Apps. `model` is a model id from the
 * options or a `<provider name>/<model id>` reference.
 */
export async function setAppAiRoleModel(
  appId: string,
  roleName: string,
  model: string | null,
): Promise<AppAiView> {
  const roles = await loadRoles(appId);
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
  const option = matchModel(await listAiModelOptions(), role.kind, model);
  await db
    .insert(schema.appAiRoleBindings)
    .values({ appId, role: roleName, modelRowId: option.id })
    .onConflictDoUpdate({
      target: [schema.appAiRoleBindings.appId, schema.appAiRoleBindings.role],
      set: { modelRowId: option.id, updatedAt: new Date() },
    });
  return getAppAiSettings(appId);
}

/** ================== call record ================== */

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
      durationMs: row.durationMs,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** This month's calls grouped by role and model, most calls first. */
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
    }))
    .sort((a, b) => b.calls - a.calls);
}
