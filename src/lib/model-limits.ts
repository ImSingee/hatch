/**
 * How a chat model's limits resolve when a field is left blank. Shared by the
 * server (what a run uses) and the edit form (what a blank field will use).
 */

/** Context window when neither an override nor the catalog gives one. */
export const FALLBACK_CONTEXT_WINDOW = 128000;
/** Max output when neither an override nor the catalog gives one. */
export const FALLBACK_MAX_TOKENS = 8192;

/** What a catalog entry says about a chat model, before any override. */
export type CatalogLimits = {
  reasoning?: boolean;
  nativeWebSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export function supportsNativeWebSearch(apiType: string): boolean {
  return apiType === 'anthropic-messages' || apiType === 'openai-responses';
}

export function resolveNativeWebSearch(
  override: boolean | null | undefined,
  catalog: boolean | undefined,
  apiType: string,
): boolean {
  return supportsNativeWebSearch(apiType) && (override ?? catalog ?? false);
}

/**
 * The catalog's max output as Hatch uses it. Some catalogs list a max output
 * close to the whole context; asking for that leaves no room for the
 * conversation and makes auto-compaction fire almost at once, so a catalog
 * value is capped at half the context the model runs with.
 */
export function cappedCatalogMaxTokens(
  catalogMaxTokens: number | undefined,
  contextWindow: number,
): number | undefined {
  return catalogMaxTokens === undefined
    ? undefined
    : Math.min(catalogMaxTokens, Math.floor(contextWindow / 2));
}

/** The values a model runs with, from its overrides and its catalog entry. */
export function resolveLimits(
  overrides: {
    reasoning: boolean | null;
    contextWindow: number | null;
    maxTokens: number | null;
  },
  catalog: CatalogLimits,
): { reasoning: boolean; contextWindow: number; maxTokens: number } {
  const contextWindow =
    overrides.contextWindow ?? catalog.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  // A value the user set is only kept within the context.
  const maxTokens = Math.min(
    overrides.maxTokens ??
      cappedCatalogMaxTokens(catalog.maxTokens, contextWindow) ??
      FALLBACK_MAX_TOKENS,
    contextWindow,
  );
  return {
    reasoning: overrides.reasoning ?? catalog.reasoning ?? false,
    contextWindow,
    maxTokens,
  };
}
