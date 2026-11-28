/**
 * Turn aidy-models' `models.json` into Hatch's catalog. Used by the sync
 * script that refreshes the bundled snapshot and by the platform's
 * background refresh, so both apply the same filters and checks.
 *
 * The upstream file has no schema version, so it is read leniently: unknown
 * fields are ignored and a malformed model outside the curated providers
 * cannot fail the build. A curated provider that disappears or changes to an
 * API type Hatch cannot run does fail it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CURATED_PROVIDERS } from './curation';
import {
  CATALOG_SCHEMA_VERSION,
  THINKING_LEVELS,
  catalogSchema,
  type Catalog,
  type CatalogModel,
  type CatalogProvider,
  type ThinkingLevel,
} from './types';

export const AIDY_MODELS_REPOSITORY = 'ImSingee/aidy-models';

/**
 * Changes whenever the curation or the catalog shape changes, so catalogs
 * built by an older Hatch are rebuilt rather than reused.
 */
export const CURATION_FINGERPRINT = `v${CATALOG_SCHEMA_VERSION}-${createHash(
  'sha256',
)
  .update(JSON.stringify(CURATED_PROVIDERS))
  .digest('hex')
  .slice(0, 16)}`;

export class CatalogBuildError extends Error {}

/** `openrouter/x:batch`, `vercel/x-batch`: offline batch-only variants. */
const BATCH_VARIANT = /[:-]batch$/;

const rawTopSchema = z.object({
  _meta: z.object({ generatedAt: z.iso.datetime({ offset: true }) }),
  providers: z.record(z.string(), z.unknown()),
  models: z.record(z.string(), z.unknown()),
});

const optionalString = z.string().optional().catch(undefined);

const rawProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  featured: z.boolean().optional().catch(undefined),
  api: z.string().nullish().catch(undefined),
  baseUrl: optionalString,
  description: optionalString,
  url: optionalString,
  apiKeyUrl: optionalString,
});

const rawModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().nullish(),
  type: optionalString,
  description: optionalString,
  releasedAt: optionalString,
  deprecated: z.boolean().optional().catch(undefined),
  abilities: z.record(z.string(), z.unknown()).optional().catch(undefined),
  reasoningEffort: z
    .object({ enum: z.array(z.string()), default: z.string().optional() })
    .optional()
    .catch(undefined),
  contextWindow: z.number().int().positive().optional().catch(undefined),
  maxOutput: z.number().int().positive().optional().catch(undefined),
  pricing: z
    .object({
      currency: z.string().optional(),
      unit: z.string().optional(),
      basePricing: z.record(z.string(), z.number()).optional(),
    })
    .optional()
    .catch(undefined),
  compat: z
    .object({
      anthropic: z.record(z.string(), z.unknown()).optional(),
    })
    .optional()
    .catch(undefined),
});
type RawModel = z.infer<typeof rawModelSchema>;

export type CatalogBuildResult = {
  catalog: Catalog;
  /** Problems that did not stop the build (dropped recommendations, …). */
  warnings: string[];
};

function clip(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return Array.from(text).slice(0, max).join('');
}

/** Keep https links only, without marketing query parameters. */
function cleanHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  // Collect first: deleting while iterating the live params skips entries.
  const tracking = Array.from(url.searchParams.keys()).filter((key) =>
    key.startsWith('utm_'),
  );
  for (const key of tracking) url.searchParams.delete(key);
  const text = url.toString();
  return text.length <= 500 ? text : undefined;
}

/** aidy `reasoningEffort` values in pi order; `none` becomes `off`. */
function thinkingLevelsOf(model: RawModel): ThinkingLevel[] {
  const values = new Set(
    (model.reasoningEffort?.enum ?? []).map((value) =>
      value === 'none' ? 'off' : value,
    ),
  );
  return THINKING_LEVELS.filter((level) => values.has(level));
}

function costOf(model: RawModel): CatalogModel['cost'] {
  const pricing = model.pricing;
  const base = pricing?.basePricing;
  if (
    !base ||
    pricing.currency !== 'USD' ||
    pricing.unit !== 'millionTokens' ||
    base.textInput === undefined ||
    base.textOutput === undefined
  )
    return undefined;
  const values = {
    input: base.textInput,
    output: base.textOutput,
    cacheRead: base.textInput_cacheRead ?? 0,
    cacheWrite: base.textInput_cacheWrite ?? 0,
  };
  return Object.values(values).every((value) => value >= 0)
    ? values
    : undefined;
}

/** Translate aidy compat hints into pi `compat` keys for the model's API. */
function compatOf(
  model: RawModel,
  apiType: CatalogProvider['apiType'],
): CatalogModel['compat'] {
  if (apiType !== 'anthropic-messages') return undefined;
  const compat: Record<string, boolean> = {};
  if (model.compat?.anthropic?.supportsAdaptiveThinking === true)
    compat.forceAdaptiveThinking = true;
  if (model.abilities?.temperature === false)
    compat.supportsTemperature = false;
  return Object.keys(compat).length ? compat : undefined;
}

function chatModel(
  model: RawModel,
  apiType: CatalogProvider['apiType'],
  nativeWebSearch?: true,
): CatalogModel {
  const levels = thinkingLevelsOf(model);
  const reasoning =
    model.abilities?.reasoning === true ||
    levels.some((level) => level !== 'off');
  const thinkingLevels = reasoning ? levels : [];
  const requestedDefault =
    model.reasoningEffort?.default === 'none'
      ? 'off'
      : model.reasoningEffort?.default;
  const defaultThinkingLevel = thinkingLevels.find(
    (level) => level === requestedDefault,
  );
  return {
    id: model.id,
    name: clip(model.name, 200) ?? model.id,
    kind: 'chat',
    description: clip(model.description, 1000),
    releasedAt: clip(model.releasedAt, 40),
    reasoning,
    nativeWebSearch:
      nativeWebSearch && model.abilities?.search === true ? true : undefined,
    thinkingLevels,
    defaultThinkingLevel,
    contextWindow: model.contextWindow,
    maxTokens: model.maxOutput,
    cost: costOf(model),
    compat: compatOf(model, apiType),
  };
}

function imageModel(model: RawModel): CatalogModel {
  return {
    id: model.id,
    name: clip(model.name, 200) ?? model.id,
    kind: 'image',
    description: clip(model.description, 1000),
    releasedAt: clip(model.releasedAt, 40),
    reasoning: false,
    thinkingLevels: [],
  };
}

/** Newest first, then by name, so search shows current models on top. */
function compareModels(a: CatalogModel, b: CatalogModel): number {
  return (
    (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '') ||
    a.name.localeCompare(b.name)
  );
}

export function buildCatalog(raw: unknown): CatalogBuildResult {
  const top = rawTopSchema.safeParse(raw);
  if (!top.success)
    throw new CatalogBuildError(
      `The model data has an unexpected shape: ${z.prettifyError(top.error)}`,
    );
  const warnings: string[] = [];
  const providers: CatalogProvider[] = [];
  const models: Record<string, CatalogModel[]> = {};

  for (const curated of CURATED_PROVIDERS) {
    const parsed = rawProviderSchema.safeParse(top.data.providers[curated.id]);
    if (!parsed.success)
      throw new CatalogBuildError(
        `Provider "${curated.id}" is missing or malformed in the model data.`,
      );
    const upstream = parsed.data;
    // Endpoint and API type come from curation, never from the feed.
    const { apiType, baseUrl } = curated;
    if (upstream.api !== apiType)
      warnings.push(
        `Provider "${curated.id}" lists API type "${String(upstream.api)}"; kept "${apiType}".`,
      );
    const upstreamUrl = upstream.baseUrl?.trim().replace(/\/+$/, '');
    if (upstreamUrl && upstreamUrl !== baseUrl.replace(/\/+$/, ''))
      warnings.push(
        `Provider "${curated.id}" lists base URL "${upstreamUrl}"; kept "${baseUrl}".`,
      );

    // A curated provider's list must be there: losing it is a broken feed,
    // not churn, and would publish a preset with no models.
    const rawModels = top.data.models[curated.id];
    if (!Array.isArray(rawModels) || rawModels.length === 0)
      throw new CatalogBuildError(
        `Provider "${curated.id}" has no model list in the model data.`,
      );
    const list: CatalogModel[] = [];
    const seen = new Set<string>();
    for (const entry of rawModels) {
      const result = rawModelSchema.safeParse(entry);
      if (!result.success || result.data.deprecated) continue;
      const model = result.data;
      if (seen.has(model.id)) continue;
      // Batch variants are served through a separate batch API, not the
      // interactive endpoint a run calls.
      if (BATCH_VARIANT.test(model.id)) continue;
      const type = model.type ?? 'chat';
      if (type === 'chat') {
        // A chat model may speak another API than its provider; one Hatch
        // provider has one API type, so such models cannot run here.
        const modelApi: string | null =
          model.api === undefined ? apiType : model.api;
        if (modelApi !== apiType || model.abilities?.toolCall !== true)
          continue;
        list.push(chatModel(model, apiType, curated.nativeWebSearch));
      } else if (type === 'image' && curated.images) {
        list.push(imageModel(model));
      } else {
        continue;
      }
      seen.add(model.id);
    }
    list.sort(compareModels);

    const chatIds = new Set(
      list.filter((model) => model.kind === 'chat').map((model) => model.id),
    );
    const recommended = curated.recommended.filter((id) => {
      if (chatIds.has(id)) return true;
      warnings.push(
        `Recommended model "${id}" is not in provider "${curated.id}".`,
      );
      return false;
    });

    providers.push({
      id: curated.id,
      name: clip(upstream.name, 120) ?? curated.id,
      apiType,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      description: clip(upstream.description, 1000),
      url: cleanHttpsUrl(upstream.url),
      apiKeyUrl: cleanHttpsUrl(upstream.apiKeyUrl),
      featured: curated.featured ?? false,
      recommended,
    });
    models[curated.id] = list;
  }

  const catalog = catalogSchema.safeParse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    source: {
      repository: AIDY_MODELS_REPOSITORY,
      generatedAt: top.data._meta.generatedAt,
      curation: CURATION_FINGERPRINT,
    },
    providers,
    models,
  });
  if (!catalog.success)
    throw new CatalogBuildError(
      `The built catalog is invalid: ${z.prettifyError(catalog.error)}`,
    );
  return { catalog: catalog.data, warnings };
}

/**
 * Refuse an update that looks like upstream breakage rather than churn: the
 * chat model count must not fall by more than 30 % against the catalog in use.
 */
export function assertPlausibleUpdate(next: Catalog, current: Catalog): void {
  const count = (catalog: Catalog) =>
    Object.values(catalog.models)
      .flat()
      .filter((model) => model.kind === 'chat').length;
  const before = count(current);
  const after = count(next);
  if (before > 0 && after < before * 0.7)
    throw new CatalogBuildError(
      `The update would drop chat models from ${before} to ${after}; kept the current catalog.`,
    );
}
