/**
 * Server-only: the effective description of a configured model — what the
 * settings page shows, what the picker offers and what a run is sent.
 *
 * Each field comes from, in order: the model row's override, the catalog
 * entry its `catalogRef` points at, and a fallback that matches what Hatch
 * used before the catalog existed. Wire details (thinking-level mapping and
 * request compat flags) prefer pi's built-in metadata for the same model,
 * because pi's API drivers are what consume them.
 */
import {
  getBuiltinModels,
  getBuiltinProviders,
  type BuiltinProvider,
} from '@earendil-works/pi-ai/providers/all';
import type { Model } from '@earendil-works/pi-ai';
import type { AgentThinkingLevel, ProviderApiType } from '~/db/schema';
import {
  catalogModelByRef,
  parseCatalogRef,
  THINKING_LEVELS,
  type CatalogModel,
} from '~server/model-catalog';

export const FALLBACK_CONTEXT_WINDOW = 128000;
export const FALLBACK_MAX_TOKENS = 8192;
/** Levels offered for a reasoning model nothing else describes. */
const FALLBACK_THINKING_LEVELS: AgentThinkingLevel[] = [
  'low',
  'medium',
  'high',
];

export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type ModelSpecRow = {
  modelId: string;
  name: string;
  catalogRef: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
};

export type ModelSpec = {
  /** `catalog` when `catalogRef` resolves; `custom` otherwise. */
  source: 'catalog' | 'custom';
  reasoning: boolean;
  /** Levels the picker offers, in order. Empty when `reasoning` is false. */
  thinkingLevels: AgentThinkingLevel[];
  defaultThinkingLevel: AgentThinkingLevel;
  contextWindow: number;
  maxTokens: number;
  cost?: ModelCost;
  /** Fields whose override differs from the catalog value. */
  overridden: Array<'reasoning' | 'contextWindow' | 'maxTokens'>;
  /** What a field would be without its override (for "Reset"). */
  catalogValues: {
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  };
  /** pi `thinkingLevelMap`: maps or disables levels on the wire. */
  thinkingLevelMap?: Partial<Record<AgentThinkingLevel, string | null>>;
  /** pi `compat` flags for the provider's API. */
  compat?: Record<string, unknown>;
};

const builtinProviders = new Set<string>(getBuiltinProviders());
const builtinCache = new Map<string, Map<string, Model<never>>>();

/** pi's built-in entry for a catalog model, when it speaks the same API. */
function piBuiltin(
  catalogProviderId: string,
  modelId: string,
  apiType: ProviderApiType,
): Model<never> | undefined {
  if (!builtinProviders.has(catalogProviderId)) return undefined;
  let models = builtinCache.get(catalogProviderId);
  if (!models) {
    models = new Map(
      getBuiltinModels(catalogProviderId as BuiltinProvider).map((model) => [
        model.id,
        model as Model<never>,
      ]),
    );
    builtinCache.set(catalogProviderId, models);
  }
  const model = models.get(modelId);
  return model && model.api === apiType ? model : undefined;
}

/**
 * The map pi needs so it neither drops a level the model supports (pi only
 * sends `xhigh`/`max` when mapped) nor sends one it does not (null).
 */
function thinkingLevelMapFor(
  levels: readonly AgentThinkingLevel[],
): Partial<Record<AgentThinkingLevel, string | null>> {
  const map: Partial<Record<AgentThinkingLevel, string | null>> = {};
  for (const level of THINKING_LEVELS) {
    if (!levels.includes(level)) map[level] = null;
    else if (level === 'xhigh' || level === 'max') map[level] = level;
  }
  return map;
}

/** Levels pi itself would accept for a built-in model. */
function piThinkingLevels(model: Model<never>): AgentThinkingLevel[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap ?? {};
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

function pickDefault(
  levels: readonly AgentThinkingLevel[],
  preferred: AgentThinkingLevel | undefined,
): AgentThinkingLevel {
  if (!levels.length) return 'off';
  if (preferred && levels.includes(preferred)) return preferred;
  // Hatch ran every reasoning model at medium before levels were selectable.
  if (levels.includes('medium')) return 'medium';
  return levels.find((level) => level !== 'off') ?? levels[0];
}

export function resolveModelSpec(
  row: ModelSpecRow,
  apiType: ProviderApiType,
): ModelSpec {
  const entry: CatalogModel | undefined = row.catalogRef
    ? catalogModelByRef(row.catalogRef)
    : undefined;
  const catalog = entry?.kind === 'chat' ? entry : undefined;
  const ref = row.catalogRef ? parseCatalogRef(row.catalogRef) : null;
  const builtin =
    catalog && ref
      ? piBuiltin(ref.providerId, ref.modelId, apiType)
      : undefined;

  const catalogValues = {
    reasoning: catalog?.reasoning,
    contextWindow: catalog?.contextWindow,
    maxTokens: catalog?.maxTokens,
  };
  const reasoning = row.reasoning ?? catalog?.reasoning ?? false;
  const contextWindow =
    row.contextWindow ?? catalog?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  // Some catalogs list a max output close to the whole context. Asking for
  // that leaves no room for the conversation and makes auto-compaction fire
  // almost at once, so a catalog value is capped at half the context. A
  // value the user set is only kept within the context.
  const catalogMaxTokens =
    catalog?.maxTokens === undefined
      ? undefined
      : Math.min(catalog.maxTokens, Math.floor(contextWindow / 2));
  const maxTokens = Math.min(
    row.maxTokens ?? catalogMaxTokens ?? FALLBACK_MAX_TOKENS,
    contextWindow,
  );
  catalogValues.maxTokens = catalogMaxTokens;

  let thinkingLevels: AgentThinkingLevel[] = [];
  let thinkingLevelMap: ModelSpec['thinkingLevelMap'];
  if (reasoning) {
    const fromCatalog = catalog?.thinkingLevels.length
      ? catalog.thinkingLevels
      : undefined;
    const fromPi = builtin ? piThinkingLevels(builtin) : undefined;
    if (fromCatalog && fromPi?.length) {
      // Offer what both the data and pi's driver agree on.
      const agreed = fromCatalog.filter((level) => fromPi.includes(level));
      thinkingLevels = agreed.length ? agreed : fromPi;
    } else {
      thinkingLevels = fromCatalog ?? fromPi ?? FALLBACK_THINKING_LEVELS;
    }
    thinkingLevelMap = {
      ...thinkingLevelMapFor(thinkingLevels),
      ...builtin?.thinkingLevelMap,
    };
    // Levels not offered stay disabled even if pi maps them.
    for (const level of THINKING_LEVELS)
      if (!thinkingLevels.includes(level)) thinkingLevelMap[level] = null;
  }

  const compat = {
    ...catalog?.compat,
    ...(builtin?.compat as Record<string, unknown> | undefined),
  };

  const overridden: ModelSpec['overridden'] = [];
  if (row.reasoning !== null && row.reasoning !== catalogValues.reasoning)
    overridden.push('reasoning');
  if (
    row.contextWindow !== null &&
    row.contextWindow !== catalogValues.contextWindow
  )
    overridden.push('contextWindow');
  if (row.maxTokens !== null && row.maxTokens !== catalogValues.maxTokens)
    overridden.push('maxTokens');

  return {
    source: catalog ? 'catalog' : 'custom',
    reasoning,
    thinkingLevels,
    defaultThinkingLevel: pickDefault(
      thinkingLevels,
      catalog?.defaultThinkingLevel,
    ),
    contextWindow,
    maxTokens,
    cost: catalog?.cost ?? (builtin?.cost as ModelCost | undefined),
    overridden: catalog ? overridden : [],
    catalogValues,
    thinkingLevelMap,
    compat: Object.keys(compat).length ? compat : undefined,
  };
}

/**
 * The level a stored choice resolves to: the saved one while the model still
 * offers it, else the model default. Explicit requests are validated by the
 * caller instead, so a bad level is rejected rather than silently replaced.
 */
export function effectiveThinkingLevel(
  spec: Pick<ModelSpec, 'thinkingLevels' | 'defaultThinkingLevel'>,
  requested: AgentThinkingLevel | null | undefined,
): AgentThinkingLevel {
  if (!spec.thinkingLevels.length) return 'off';
  if (requested && spec.thinkingLevels.includes(requested)) return requested;
  return spec.defaultThinkingLevel;
}
