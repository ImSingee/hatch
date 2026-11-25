/**
 * The built-in model catalog: providers Hatch can preset and the models they
 * offer, trimmed from aidy-models. Shared by the bundled snapshot, the
 * background refresh and the catalog readers, so every copy has one shape.
 */
import { z } from 'zod';

export const CATALOG_SCHEMA_VERSION = 1;

/** API types Hatch can run the Agent with (mirrors `ProviderApiType`). */
export const CATALOG_API_TYPES = [
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
] as const;

/** pi thinking levels, plus `off` for models that can skip thinking. */
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const thinkingLevelSchema = z.enum(THINKING_LEVELS);

const shortText = (max: number) => z.string().min(1).max(max);
const httpsUrl = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine((value) => !/\s/.test(value));

export const catalogProviderSchema = z.object({
  id: shortText(80),
  name: shortText(120),
  apiType: z.enum(CATALOG_API_TYPES),
  baseUrl: z.url({ protocol: /^https?$/ }).max(500),
  description: z.string().max(1000).optional(),
  url: httpsUrl.optional(),
  apiKeyUrl: httpsUrl.optional(),
  featured: z.boolean(),
  /** Model ids enabled by default when the provider is added, in order. */
  recommended: z.array(shortText(200)).max(20),
});
export type CatalogProvider = z.infer<typeof catalogProviderSchema>;

export const catalogCostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

export const catalogModelSchema = z.object({
  id: shortText(200),
  name: shortText(200),
  kind: z.enum(['chat', 'image']),
  description: z.string().max(1000).optional(),
  releasedAt: z.string().max(40).optional(),
  reasoning: z.boolean(),
  /**
   * Levels the model accepts, in pi order. Empty for non-reasoning models.
   * `off` is listed only when the model can answer without thinking.
   */
  thinkingLevels: z.array(thinkingLevelSchema),
  defaultThinkingLevel: thinkingLevelSchema.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  /** USD per million tokens. */
  cost: catalogCostSchema.optional(),
  /** Request-format hints in pi's `compat` shape for this model's API. */
  compat: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
});
export type CatalogModel = z.infer<typeof catalogModelSchema>;

export const catalogSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  source: z.object({
    repository: z.string().max(200),
    /** When aidy-models generated the data this catalog was built from. */
    generatedAt: z.iso.datetime({ offset: true }),
    /**
     * Fingerprint of the curation the catalog was built with. A stored
     * catalog built with another curation is stale after an upgrade.
     */
    curation: z.string().max(80),
  }),
  providers: z.array(catalogProviderSchema),
  models: z.record(z.string(), z.array(catalogModelSchema)),
});
export type Catalog = z.infer<typeof catalogSchema>;
