import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '~/db';
import type { AgentModelKind, ProviderApiType } from '~/db/schema';
import { authMiddleware } from './auth';
import { seedDefaultProviders } from '~agent/seed-providers';
import { imageDriverFor } from './images/drivers';
import {
  assertApiTypeKeepsModels,
  createProviderModel,
  deleteProviderModel,
  updateProviderModel,
} from './provider-models';

const apiTypeSchema = z.enum([
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
]);

export type ProviderModel = {
  id: string;
  kind: AgentModelKind;
  modelId: string;
  name: string;
  description: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  enabled: boolean;
  sortOrder: number;
};

export type ProviderWithModels = {
  id: string;
  name: string;
  apiType: ProviderApiType;
  baseUrl: string;
  enabled: boolean;
  sortOrder: number;
  /** Image model ids to suggest; empty when the API cannot make images. */
  imageModelSuggestions: string[];
  models: ProviderModel[];
};

/**
 * List providers with their models. Seeds defaults on first run. API keys are
 * never returned to the client — not even a masked fragment.
 */
export const listProviders = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<ProviderWithModels[]> => {
    await seedDefaultProviders();

    const providers = await db.query.agentProviders.findMany({
      orderBy: { sortOrder: 'asc', createdAt: 'asc' },
    });
    const allModels =
      providers.length === 0
        ? []
        : await db.query.agentModels.findMany({
            where: { providerId: { in: providers.map((p) => p.id) } },
            orderBy: { sortOrder: 'asc', createdAt: 'asc' },
          });
    const modelsByProvider = new Map<string, typeof allModels>();
    for (const model of allModels) {
      const list = modelsByProvider.get(model.providerId) ?? [];
      list.push(model);
      modelsByProvider.set(model.providerId, list);
    }

    const result: ProviderWithModels[] = [];
    for (const p of providers) {
      const models = modelsByProvider.get(p.id) ?? [];
      result.push({
        id: p.id,
        name: p.name,
        apiType: p.apiType,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        sortOrder: p.sortOrder,
        imageModelSuggestions: [
          ...(imageDriverFor(p.apiType)?.suggestedModels ?? []),
        ],
        models: models.map((m) => ({
          id: m.id,
          kind: m.kind,
          modelId: m.modelId,
          name: m.name,
          description: m.description,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          enabled: m.enabled,
          sortOrder: m.sortOrder,
        })),
      });
    }
    return result;
  });

const createProviderSchema = z.object({
  name: z.string().min(1),
  apiType: apiTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
});

export const createProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createProviderSchema>) =>
    createProviderSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const [row] = await db
      .insert(schema.agentProviders)
      .values({
        name: data.name,
        apiType: data.apiType,
        baseUrl: data.baseUrl.trim(),
        apiKey: data.apiKey.trim(),
      })
      .returning();
    return { id: row.id };
  });

const updateProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  apiType: apiTypeSchema.optional(),
  baseUrl: z.string().min(1).optional(),
  /** Empty string means "keep existing key". */
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const updateProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof updateProviderSchema>) =>
    updateProviderSchema.parse(data),
  )
  .handler(async ({ data }) => {
    if (data.apiType !== undefined)
      await assertApiTypeKeepsModels(data.id, data.apiType);
    const patch: Partial<typeof schema.agentProviders.$inferInsert> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.apiType !== undefined) patch.apiType = data.apiType;
    if (data.baseUrl !== undefined) patch.baseUrl = data.baseUrl.trim();
    // Trim first so a whitespace-only value keeps the existing key instead of
    // silently wiping it.
    const trimmedKey = data.apiKey?.trim();
    if (trimmedKey) patch.apiKey = trimmedKey;
    if (data.enabled !== undefined) patch.enabled = data.enabled;

    await db
      .update(schema.agentProviders)
      .set(patch)
      .where(eq(schema.agentProviders.id, data.id));
    return { ok: true };
  });

export const deleteProvider = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await db
      .delete(schema.agentProviders)
      .where(eq(schema.agentProviders.id, data.id));
    return { ok: true };
  });

// A loose bound on the wire; the domain service enforces the real limit.
const descriptionSchema = z.string().max(1000);

const createModelSchema = z.object({
  providerId: z.string().min(1),
  kind: z.enum(['chat', 'image']).default('chat'),
  modelId: z.string().min(1),
  name: z.string().min(1),
  description: descriptionSchema.default(''),
  reasoning: z.boolean().default(false),
  contextWindow: z.number().int().positive().default(128000),
  maxTokens: z.number().int().positive().default(8192),
});

export const createModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof createModelSchema>) =>
    createModelSchema.parse(data),
  )
  .handler(async ({ data }) => {
    const row = await createProviderModel(data);
    return { id: row.id };
  });

const updateModelSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: descriptionSchema.optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
});

export const updateModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: z.input<typeof updateModelSchema>) =>
    updateModelSchema.parse(data),
  )
  .handler(async ({ data }) => {
    await updateProviderModel(data);
    return { ok: true };
  });

export const deleteModel = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data }) => {
    await deleteProviderModel(data.id);
    return { ok: true };
  });
