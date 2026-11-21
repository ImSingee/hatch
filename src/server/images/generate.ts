/** Server-only: bounded image generation with the instance's image model. */
import sharp from 'sharp';
import { AppError } from '~server/errors';
import { candidatePath, saveCandidate } from './candidates';
import type { ImageQuality } from './drivers';
import { resolveImageModel } from './model';
import { composeGlyphTile, isTileColor } from './tile';

export const MAX_IMAGES_PER_CALL = 4;
export const MAX_PROMPT_LENGTH = 4000;
export const MAX_IMAGES_PER_HOUR = 30;
const REQUEST_TIMEOUT_MS = 120_000;
const HOUR_MS = 60 * 60 * 1000;

/** Start times of recent images; a spend guard, reset by a restart. */
const recent: number[] = [];

function reserve(count: number, now: number): void {
  while (recent.length && now - recent[0] > HOUR_MS) recent.shift();
  if (recent.length + count > MAX_IMAGES_PER_HOUR)
    throw new AppError(
      `Image generation is limited to ${MAX_IMAGES_PER_HOUR} images per hour. Try again later.`,
      429,
    );
  for (let index = 0; index < count; index += 1) recent.push(now);
}

export type GenerateImagesInput = {
  prompt: string;
  count?: number;
  quality?: ImageQuality;
  /**
   * When set, each result must be a white glyph on black and is composed
   * onto a solid tile of this `#RRGGBB` colour.
   */
  glyphTile?: string;
};

export type GeneratedImages = {
  model: string;
  images: { id: string; path: string }[];
};

export async function generateImages(
  input: GenerateImagesInput,
  signal?: AbortSignal,
): Promise<GeneratedImages> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH)
    throw new AppError(
      `Prompt must be 1 to ${MAX_PROMPT_LENGTH} characters.`,
      400,
    );
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES_PER_CALL)
    throw new AppError(`Count must be 1 to ${MAX_IMAGES_PER_CALL}.`, 400);
  const glyphTile = input.glyphTile;
  if (glyphTile !== undefined && !isTileColor(glyphTile))
    throw new AppError('Tile background must be a #RRGGBB colour.', 400);

  const { driver, provider, modelId } = await resolveImageModel();
  reserve(count, Date.now());
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const results = await Promise.allSettled(
    Array.from({ length: count }, async () => {
      const raw = await driver.generate(provider, {
        model: modelId,
        prompt,
        quality: input.quality ?? 'low',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      // Never store provider bytes as-is: decode and re-encode.
      const png =
        glyphTile === undefined
          ? await sharp(raw, { limitInputPixels: 4096 * 4096 })
              .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
              .png()
              .toBuffer()
          : await composeGlyphTile(raw, glyphTile);
      const id = await saveCandidate(png);
      return { id, path: candidatePath(id) };
    }),
  );
  const images = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (!images.length) {
    const failure = results.find((result) => result.status === 'rejected');
    throw failure?.reason instanceof AppError
      ? failure.reason
      : new AppError('Image generation failed.', 503);
  }
  return { model: modelId, images };
}
