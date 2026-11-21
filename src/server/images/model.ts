/** Server-only: the instance's selected image-generation model. */
import { db } from '~/db';
import { AppError } from '~server/errors';
import {
  clearPlatformConfig,
  getPlatformConfig,
  setPlatformConfig,
} from '~server/platform-config';
import {
  imageDriverFor,
  type ImageDriver,
  type ImageProvider,
} from './drivers';

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type ImageModelState = {
  /** Null when no model is chosen or its provider no longer exists. */
  selected: {
    providerId: string;
    providerName: string;
    modelId: string;
    /** False while the provider is disabled or has no API key. */
    usable: boolean;
  } | null;
  /** Providers whose wire API can generate images. */
  providers: {
    id: string;
    name: string;
    enabled: boolean;
    suggestedModels: string[];
  }[];
};

export async function getImageModelState(): Promise<ImageModelState> {
  const [config, rows] = await Promise.all([
    getPlatformConfig('image.model'),
    db.query.agentProviders.findMany({
      orderBy: { sortOrder: 'asc', createdAt: 'asc' },
    }),
  ]);
  const chosen = config
    ? rows.find((row) => row.id === config.providerId)
    : undefined;
  return {
    selected:
      config && chosen && imageDriverFor(chosen.apiType)
        ? {
            providerId: chosen.id,
            providerName: chosen.name,
            modelId: config.modelId,
            usable: chosen.enabled && chosen.apiKey.length > 0,
          }
        : null,
    providers: rows.flatMap((row) => {
      const driver = imageDriverFor(row.apiType);
      return driver
        ? [
            {
              id: row.id,
              name: row.name,
              enabled: row.enabled,
              suggestedModels: [...driver.suggestedModels],
            },
          ]
        : [];
    }),
  };
}

export async function setImageModel(input: {
  providerId: string;
  modelId: string;
}): Promise<ImageModelState> {
  const modelId = input.modelId.trim();
  if (!MODEL_ID_RE.test(modelId))
    throw new AppError('Invalid image model id.', 400);
  const provider = await db.query.agentProviders.findFirst({
    where: { id: input.providerId },
    columns: { id: true, apiType: true },
  });
  if (!provider) throw new AppError('Provider not found.', 404);
  if (!imageDriverFor(provider.apiType))
    throw new AppError('This provider cannot generate images.', 400);
  await setPlatformConfig('image.model', { providerId: provider.id, modelId });
  return getImageModelState();
}

export async function clearImageModel(): Promise<ImageModelState> {
  // The value column is NOT NULL; no row means no selection.
  await clearPlatformConfig('image.model');
  return getImageModelState();
}

/** Resolve the configured model for one generation, or fail with a 409. */
export async function resolveImageModel(): Promise<{
  driver: ImageDriver;
  provider: ImageProvider;
  modelId: string;
}> {
  const config = await getPlatformConfig('image.model');
  const row = config
    ? await db.query.agentProviders.findFirst({
        where: { id: config.providerId },
      })
    : undefined;
  const driver = row ? imageDriverFor(row.apiType) : null;
  if (!config || !row || !driver)
    throw new AppError('No image model is configured.', 409);
  if (!row.enabled || !row.apiKey)
    throw new AppError(
      'The image model provider is disabled or has no API key.',
      409,
    );
  return {
    driver,
    provider: { baseUrl: row.baseUrl, apiKey: row.apiKey },
    modelId: config.modelId,
  };
}
