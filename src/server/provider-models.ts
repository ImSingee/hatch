/**
 * Server-only: create, change and remove a provider's models. The Web UI
 * Server Functions and the public image-model RPCs share these rules.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AgentModelKind, ProviderApiType } from '~/db/schema';
import { AppError } from '~server/errors';
import { imageDriverFor } from '~server/images/drivers';

/** Model ids the image drivers send verbatim to the provider. */
export const IMAGE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const MAX_MODEL_DESCRIPTION_LENGTH = 200;

export type CreateProviderModelInput = {
  providerId: string;
  kind: AgentModelKind;
  modelId: string;
  /** Blank falls back to the model id. */
  name?: string;
  description?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

export type UpdateProviderModelInput = {
  id: string;
  kind?: AgentModelKind;
  modelId?: string;
  name?: string;
  description?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type ModelRow = typeof schema.agentModels.$inferSelect;

function checkModelId(kind: AgentModelKind, value: string): string {
  const modelId = value.trim();
  if (!modelId) throw new AppError('Model ID is required.', 400);
  if (kind === 'image' && !IMAGE_MODEL_ID_RE.test(modelId))
    throw new AppError('Invalid image model id.', 400);
  return modelId;
}

function checkDescription(value: string): string {
  const description = value.trim();
  if (Array.from(description).length > MAX_MODEL_DESCRIPTION_LENGTH)
    throw new AppError(
      `Description must be at most ${MAX_MODEL_DESCRIPTION_LENGTH} characters.`,
      400,
    );
  return description;
}

export function canGenerateImages(apiType: ProviderApiType): boolean {
  return imageDriverFor(apiType) !== null;
}

export async function createProviderModel(
  input: CreateProviderModelInput,
): Promise<ModelRow> {
  const provider = await db.query.agentProviders.findFirst({
    where: { id: input.providerId },
    columns: { id: true, apiType: true },
  });
  if (!provider) throw new AppError('Provider not found.', 404);
  if (input.kind === 'image' && !canGenerateImages(provider.apiType))
    throw new AppError('This provider cannot generate images.', 400);
  const modelId = checkModelId(input.kind, input.modelId);
  const [row] = await db
    .insert(schema.agentModels)
    .values({
      providerId: provider.id,
      kind: input.kind,
      modelId,
      name: input.name?.trim() || modelId,
      description: checkDescription(input.description ?? ''),
      reasoning: input.reasoning,
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
    })
    .returning();
  return row;
}

/**
 * Change a model's fields, including its kind. A model turned into an image
 * model must suit its provider; one turned away from chat simply stops being
 * offered to the Agent. `onlyKind`, when given, must match the stored kind,
 * so an image-model command can never edit a chat model.
 */
export async function updateProviderModel(
  input: UpdateProviderModelInput,
  onlyKind?: AgentModelKind,
): Promise<ModelRow> {
  const current = await db.query.agentModels.findFirst({
    where: { id: input.id },
  });
  if (!current || (onlyKind && current.kind !== onlyKind))
    throw new AppError('Model not found.', 404);
  const kind = input.kind ?? current.kind;
  if (kind === 'image' && kind !== current.kind) {
    const provider = await db.query.agentProviders.findFirst({
      where: { id: current.providerId },
      columns: { apiType: true },
    });
    if (!provider || !canGenerateImages(provider.apiType))
      throw new AppError('This provider cannot generate images.', 400);
  }
  const patch: Partial<typeof schema.agentModels.$inferInsert> = {};
  if (kind !== current.kind) {
    patch.kind = kind;
    // The stored id must also suit the new kind.
    checkModelId(kind, input.modelId ?? current.modelId);
  }
  if (input.modelId !== undefined)
    patch.modelId = checkModelId(kind, input.modelId);
  if (input.name !== undefined)
    patch.name = input.name.trim() || patch.modelId || current.modelId;
  if (input.description !== undefined)
    patch.description = checkDescription(input.description);
  if (input.reasoning !== undefined) patch.reasoning = input.reasoning;
  if (input.contextWindow !== undefined)
    patch.contextWindow = input.contextWindow;
  if (input.maxTokens !== undefined) patch.maxTokens = input.maxTokens;
  if (!Object.keys(patch).length) return current;
  const [row] = await db
    .update(schema.agentModels)
    .set(patch)
    .where(eq(schema.agentModels.id, current.id))
    .returning();
  return row;
}

export async function deleteProviderModel(
  id: string,
  kind?: AgentModelKind,
): Promise<void> {
  const deleted = await db
    .delete(schema.agentModels)
    .where(
      kind
        ? and(eq(schema.agentModels.id, id), eq(schema.agentModels.kind, kind))
        : eq(schema.agentModels.id, id),
    )
    .returning({ id: schema.agentModels.id });
  if (kind && !deleted.length) throw new AppError('Model not found.', 404);
}

/**
 * A provider that holds image models must keep an API type that can
 * generate them; otherwise those models would silently stop working.
 */
export async function assertApiTypeKeepsModels(
  providerId: string,
  apiType: ProviderApiType,
): Promise<void> {
  if (canGenerateImages(apiType)) return;
  const image = await db.query.agentModels.findFirst({
    where: { providerId, kind: 'image' },
    columns: { id: true },
  });
  if (image)
    throw new AppError(
      'This API type cannot generate images. Remove the provider’s image models first.',
      409,
    );
}
