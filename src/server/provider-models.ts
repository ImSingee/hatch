/**
 * Server-only: create, change and remove a provider's models. The Web UI
 * Server Functions and the public RPCs share these rules.
 *
 * A model refers to a catalog entry (`catalogRef`) for its metadata; the
 * reasoning, context window and max tokens columns override it when set.
 * Passing `null` for one of them clears the override, so the catalog value
 * applies again.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AgentModelKind, ProviderApiType } from '~/db/schema';
import { AppError } from '~server/errors';
import { imageDriverFor } from '~server/images/drivers';
import { catalogModelByRef, matchCatalogModel } from '~server/model-catalog';

/** Model ids the image drivers send verbatim to the provider. */
export const IMAGE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const MAX_MODEL_ID_LENGTH = 200;
export const MAX_MODEL_NAME_LENGTH = 200;
export const MAX_MODEL_DESCRIPTION_LENGTH = 200;

/** Fields shared by create and update. */
type ModelFields = {
  kind?: AgentModelKind;
  modelId?: string;
  /** Blank falls back to the catalog name, then the model id. */
  name?: string;
  description?: string;
  /**
   * Catalog entry for the metadata. Unset matches automatically (again when
   * the model id changes); null detaches the model from the catalog.
   */
  catalogRef?: string | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  enabled?: boolean;
};

export type CreateProviderModelInput = ModelFields & {
  providerId: string;
  kind: AgentModelKind;
  modelId: string;
};

export type UpdateProviderModelInput = ModelFields & { id: string };

type ModelRow = typeof schema.agentModels.$inferSelect;
type Executor = Pick<typeof db, 'query' | 'insert' | 'select'>;

function checkModelId(kind: AgentModelKind, value: string): string {
  const modelId = value.trim();
  if (!modelId)
    throw new AppError('Model ID is required.', 400, {
      code: 'providers.modelIdRequired',
    });
  if (Array.from(modelId).length > MAX_MODEL_ID_LENGTH)
    throw new AppError(
      `Model ID must be at most ${MAX_MODEL_ID_LENGTH} characters.`,
      400,
      {
        code: 'providers.modelIdTooLong',
        params: { max: MAX_MODEL_ID_LENGTH },
      },
    );
  if (kind === 'image' && !IMAGE_MODEL_ID_RE.test(modelId))
    throw new AppError('Invalid image model id.', 400, {
      code: 'providers.invalidImageModelId',
    });
  return modelId;
}

function checkName(value: string): string {
  const name = value.trim();
  if (Array.from(name).length > MAX_MODEL_NAME_LENGTH)
    throw new AppError(
      `Name must be at most ${MAX_MODEL_NAME_LENGTH} characters.`,
      400,
      { code: 'providers.nameTooLong', params: { max: MAX_MODEL_NAME_LENGTH } },
    );
  return name;
}

function checkDescription(value: string): string {
  const description = value.trim();
  if (Array.from(description).length > MAX_MODEL_DESCRIPTION_LENGTH)
    throw new AppError(
      `Description must be at most ${MAX_MODEL_DESCRIPTION_LENGTH} characters.`,
      400,
      {
        code: 'providers.descriptionTooLong',
        params: { max: MAX_MODEL_DESCRIPTION_LENGTH },
      },
    );
  return description;
}

function checkPositive(
  field: 'contextWindow' | 'maxTokens',
  value: number | null | undefined,
): number | null | undefined {
  if (value === null || value === undefined) return value;
  if (!Number.isInteger(value) || value <= 0)
    throw new AppError(
      `${field === 'contextWindow' ? 'Context window' : 'Max output tokens'} must be a positive whole number.`,
      400,
      {
        code:
          field === 'contextWindow'
            ? 'providers.contextWindowNotPositive'
            : 'providers.maxTokensNotPositive',
      },
    );
  return value;
}

/** An explicit catalog reference must exist and describe this kind. */
function checkCatalogRef(ref: string, kind: AgentModelKind): string {
  const entry = catalogModelByRef(ref);
  if (!entry)
    throw new AppError(`Catalog model "${ref}" does not exist.`, 400, {
      code: 'providers.catalogModelMissing',
      params: { ref },
    });
  if (entry.kind !== kind)
    throw new AppError(`Catalog model "${ref}" is not a ${kind} model.`, 400, {
      code: 'providers.catalogModelWrongKind',
      params: { ref },
    });
  return ref;
}

/** Image models have no chat metadata; setting some is a caller mistake. */
function rejectChatFieldsForImage(kind: AgentModelKind, input: ModelFields) {
  if (
    kind === 'image' &&
    [input.reasoning, input.contextWindow, input.maxTokens].some(
      (value) => value !== undefined && value !== null,
    )
  )
    throw new AppError(
      'Image models have no reasoning, context window or max tokens.',
      400,
      { code: 'providers.imageModelChatFields' },
    );
}

export function canGenerateImages(apiType: ProviderApiType): boolean {
  return imageDriverFor(apiType) !== null;
}

async function loadProvider(executor: Executor, providerId: string) {
  const provider = await executor.query.agentProviders.findFirst({
    where: { id: providerId },
    columns: { id: true, apiType: true, catalogProviderId: true },
  });
  if (!provider)
    throw new AppError('Provider not found.', 404, {
      code: 'providers.providerNotFound',
    });
  return provider;
}

export async function createProviderModel(
  input: CreateProviderModelInput,
  executor: Executor = db,
): Promise<ModelRow> {
  const provider = await loadProvider(executor, input.providerId);
  if (input.kind === 'image' && !canGenerateImages(provider.apiType))
    throw new AppError('This provider cannot generate images.', 400, {
      code: 'providers.cannotGenerateImages',
    });
  const modelId = checkModelId(input.kind, input.modelId);
  rejectChatFieldsForImage(input.kind, input);
  const duplicate = await executor.query.agentModels.findFirst({
    where: { providerId: provider.id, modelId, kind: input.kind },
    columns: { id: true },
  });
  if (duplicate)
    throw new AppError(
      `This provider already has the ${input.kind} model "${modelId}".`,
      409,
      { code: 'providers.duplicateModel', params: { modelId } },
    );
  const catalogRef =
    input.catalogRef === undefined
      ? matchCatalogModel(provider.catalogProviderId, modelId, input.kind)
      : input.catalogRef === null
        ? null
        : checkCatalogRef(input.catalogRef, input.kind);
  const catalogName = catalogRef
    ? catalogModelByRef(catalogRef)?.name
    : undefined;
  const [{ next }] = await executor
    .select({
      next: sql<number>`coalesce(max(${schema.agentModels.sortOrder}) + 1, 0)`,
    })
    .from(schema.agentModels)
    .where(eq(schema.agentModels.providerId, provider.id));
  const [row] = await executor
    .insert(schema.agentModels)
    .values({
      providerId: provider.id,
      kind: input.kind,
      modelId,
      name: checkName(input.name ?? '') || catalogName || modelId,
      description: checkDescription(input.description ?? ''),
      catalogRef,
      reasoning: input.kind === 'chat' ? (input.reasoning ?? null) : null,
      contextWindow:
        input.kind === 'chat'
          ? (checkPositive('contextWindow', input.contextWindow) ?? null)
          : null,
      maxTokens:
        input.kind === 'chat'
          ? (checkPositive('maxTokens', input.maxTokens) ?? null)
          : null,
      enabled: input.enabled ?? true,
      sortOrder: Number(next),
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
    throw new AppError('Model not found.', 404, {
      code: 'providers.modelNotFound',
    });
  const provider = await loadProvider(db, current.providerId);
  const kind = input.kind ?? current.kind;
  rejectChatFieldsForImage(kind, input);
  if (kind === 'image' && kind !== current.kind) {
    if (!canGenerateImages(provider.apiType))
      throw new AppError('This provider cannot generate images.', 400, {
        code: 'providers.cannotGenerateImages',
      });
  }
  const patch: Partial<typeof schema.agentModels.$inferInsert> = {};
  if (kind !== current.kind) {
    patch.kind = kind;
    // The stored id must also suit the new kind.
    checkModelId(kind, input.modelId ?? current.modelId);
  }
  const modelId =
    input.modelId === undefined
      ? current.modelId
      : checkModelId(kind, input.modelId);
  if (modelId !== current.modelId) patch.modelId = modelId;

  if (input.catalogRef !== undefined) {
    patch.catalogRef =
      input.catalogRef === null
        ? null
        : checkCatalogRef(input.catalogRef, kind);
  } else if (patch.modelId !== undefined || patch.kind !== undefined) {
    // A new id or kind may describe another catalog entry.
    patch.catalogRef = matchCatalogModel(
      provider.catalogProviderId,
      modelId,
      kind,
    );
  }

  if (input.name !== undefined) {
    const ref =
      patch.catalogRef === undefined ? current.catalogRef : patch.catalogRef;
    patch.name =
      checkName(input.name) ||
      (ref ? catalogModelByRef(ref)?.name : undefined) ||
      modelId;
  }
  if (input.description !== undefined)
    patch.description = checkDescription(input.description);
  if (input.reasoning !== undefined) patch.reasoning = input.reasoning;
  if (input.contextWindow !== undefined)
    patch.contextWindow = checkPositive('contextWindow', input.contextWindow);
  if (input.maxTokens !== undefined)
    patch.maxTokens = checkPositive('maxTokens', input.maxTokens);
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (kind === 'image') {
    // Image models have no chat metadata.
    patch.reasoning = null;
    patch.contextWindow = null;
    patch.maxTokens = null;
  }
  if (!Object.keys(patch).length) return current;
  if (patch.modelId !== undefined || patch.kind !== undefined) {
    const duplicate = await db.query.agentModels.findFirst({
      where: {
        providerId: current.providerId,
        modelId,
        kind,
        id: { ne: current.id },
      },
      columns: { id: true },
    });
    if (duplicate)
      throw new AppError(
        `This provider already has the ${kind} model "${modelId}".`,
        409,
        { code: 'providers.duplicateModel', params: { modelId } },
      );
  }
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
  if (!deleted.length)
    throw new AppError('Model not found.', 404, {
      code: 'providers.modelNotFound',
    });
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
  // The provider form resends the API type on every save; only a change can
  // strand image models.
  const provider = await db.query.agentProviders.findFirst({
    where: { id: providerId },
    columns: { apiType: true },
  });
  if (!provider || provider.apiType === apiType) return;
  const image = await db.query.agentModels.findFirst({
    where: { providerId, kind: 'image' },
    columns: { id: true },
  });
  if (image)
    throw new AppError(
      'This API type cannot generate images. Remove the provider’s image models first.',
      409,
      { code: 'providers.apiTypeDropsImageModels' },
    );
}
