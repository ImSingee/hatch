/**
 * Server-only: the instance's image models. Each is a provider model of kind
 * `image`; a caller names one per generation or gets the default, the first
 * usable one in provider and model order.
 */
import { db } from '~/db';
import { AppError } from '~server/errors';
import {
  createProviderModel,
  deleteProviderModel,
  updateProviderModel,
} from '~server/provider-models';
import {
  imageDriverFor,
  type ImageDriver,
  type ImageProvider,
} from './drivers';

export type ImageModelView = {
  /** Image model id: what `generate` and the update commands take. */
  id: string;
  providerId: string;
  providerName: string;
  /** Model id sent to the provider. */
  modelId: string;
  name: string;
  description: string;
  /** False while its provider is disabled, has no key or cannot make images. */
  usable: boolean;
};

export type ImageModelList = {
  models: ImageModelView[];
  /** The model a generation without an explicit model uses. */
  defaultModelId: string | null;
  /** Providers that can hold image models. Never a key. */
  providers: {
    id: string;
    name: string;
    enabled: boolean;
    suggestedModels: string[];
  }[];
};

type ProviderRow = Awaited<
  ReturnType<typeof db.query.agentProviders.findMany>
>[number];

const usable = (provider: ProviderRow, enabled: boolean) =>
  enabled &&
  provider.enabled &&
  provider.apiKey.length > 0 &&
  imageDriverFor(provider.apiType) !== null;

async function load() {
  const providers = await db.query.agentProviders.findMany({
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  const models = await db.query.agentModels.findMany({
    where: { kind: 'image' },
    orderBy: { sortOrder: 'asc', createdAt: 'asc' },
  });
  // Provider order first, then each provider's own model order.
  const ordered = providers.flatMap((provider) =>
    models
      .filter((model) => model.providerId === provider.id)
      .map((model) => ({ provider, model })),
  );
  return { providers, ordered };
}

export async function listImageModels(): Promise<ImageModelList> {
  const { providers, ordered } = await load();
  const models = ordered.map(({ provider, model }) => ({
    id: model.id,
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.modelId,
    name: model.name,
    description: model.description,
    usable: usable(provider, model.enabled),
  }));
  return {
    models,
    defaultModelId: models.find((model) => model.usable)?.id ?? null,
    providers: providers.flatMap((provider) => {
      const driver = imageDriverFor(provider.apiType);
      return driver
        ? [
            {
              id: provider.id,
              name: provider.name,
              enabled: provider.enabled,
              suggestedModels: [...driver.suggestedModels],
            },
          ]
        : [];
    }),
  };
}

async function view(id: string): Promise<ImageModelView> {
  const model = (await listImageModels()).models.find((item) => item.id === id);
  if (!model) throw new AppError('Image model not found.', 404);
  return model;
}

export async function createImageModel(input: {
  providerId: string;
  modelId: string;
  name?: string;
  description?: string;
}): Promise<ImageModelView> {
  const row = await createProviderModel({ ...input, kind: 'image' });
  return view(row.id);
}

export async function updateImageModel(input: {
  id: string;
  modelId?: string;
  name?: string;
  description?: string;
}): Promise<ImageModelView> {
  const row = await updateProviderModel(input, 'image');
  return view(row.id);
}

export async function deleteImageModel(id: string): Promise<void> {
  await deleteProviderModel(id, 'image');
}

/**
 * Resolve the model for one generation: the named image model, or the
 * default when none is named. Fails with a 404 for an unknown id and a 409
 * when the model cannot run.
 */
export async function resolveImageModel(imageModelId?: string): Promise<{
  id: string;
  driver: ImageDriver;
  provider: ImageProvider;
  modelId: string;
}> {
  const { ordered } = await load();
  const entry = imageModelId
    ? ordered.find(({ model }) => model.id === imageModelId)
    : ordered.find(({ provider, model }) => usable(provider, model.enabled));
  if (!entry) {
    if (imageModelId) throw new AppError('Image model not found.', 404);
    throw new AppError('No usable image model is configured.', 409);
  }
  const { provider, model } = entry;
  const driver = imageDriverFor(provider.apiType);
  if (!driver || !usable(provider, model.enabled))
    throw new AppError(
      'The image model’s provider is disabled or has no API key.',
      409,
    );
  return {
    id: model.id,
    driver,
    provider: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
    modelId: model.modelId,
  };
}
