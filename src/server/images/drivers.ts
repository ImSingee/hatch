/**
 * Server-only: image-generation drivers, one per provider wire API.
 *
 * Callers never talk to a provider directly: they resolve the configured
 * image model and call `generate`. Adding a provider means adding a driver
 * here; nothing else changes.
 */
import type { ProviderApiType } from '~/db/schema';
import { AppError } from '~server/errors';

export type ImageQuality = 'low' | 'medium' | 'high';

export type ImageRequest = {
  model: string;
  prompt: string;
  quality: ImageQuality;
  /** `transparent` asks for a cut-out subject with an alpha channel. */
  background: 'opaque' | 'transparent';
  signal: AbortSignal;
};

export type ImageProvider = { baseUrl: string; apiKey: string };

export type ImageDriver = {
  /** Model ids offered as suggestions; any id the provider accepts works. */
  suggestedModels: readonly string[];
  /** Returns one square PNG. */
  generate(provider: ImageProvider, request: ImageRequest): Promise<Buffer>;
};

/** Upper bound for one decoded provider image. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROVIDER_MESSAGE_LIMIT = 300;

function providerMessage(body: unknown, apiKey: string): string {
  const message =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error?: { message?: unknown } }).error?.message
      : undefined;
  const text = typeof message === 'string' ? message : 'no details';
  return text.replaceAll(apiKey, '[redacted]').slice(0, PROVIDER_MESSAGE_LIMIT);
}

/**
 * Read a provider response as JSON without buffering more than one image's
 * worth of base64 plus envelope. Returns null when it is not JSON; throws when
 * the body exceeds the limit.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  const limit = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          'The image provider returned an oversized response.',
          503,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * OpenAI Images API (`POST {baseUrl}/images/generations`). GPT image models
 * always answer with base64 PNG data, so no response format is requested.
 */
const openai: ImageDriver = {
  suggestedModels: ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'],
  async generate(provider, request) {
    let response: Response;
    try {
      response = await fetch(
        `${provider.baseUrl.replace(/\/+$/, '')}/images/generations`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${provider.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: request.model,
            prompt: request.prompt,
            n: 1,
            size: '1024x1024',
            quality: request.quality,
            background: request.background,
            output_format: 'png',
          }),
          signal: request.signal,
          redirect: 'error',
        },
      );
    } catch {
      throw new AppError('The image provider could not be reached.', 503);
    }
    const body = await readJsonBody(response);
    if (!response.ok) {
      // Provider 4xx is actionable (bad model id, blocked prompt, unverified
      // organisation); anything else is an outage from the caller's view.
      if (response.status >= 400 && response.status < 500)
        throw new AppError(
          `The image provider rejected the request (${response.status}): ${providerMessage(body, provider.apiKey)}`,
          400,
        );
      throw new AppError('The image provider failed.', 503);
    }
    const encoded = (body as { data?: { b64_json?: unknown }[] } | null)
      ?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded)
      throw new AppError('The image provider returned no image.', 503);
    if (encoded.length > (MAX_IMAGE_BYTES * 4) / 3)
      throw new AppError(
        'The image provider returned an oversized image.',
        503,
      );
    return Buffer.from(encoded, 'base64');
  },
};

const DRIVERS: Partial<Record<ProviderApiType, ImageDriver>> = {
  'openai-responses': openai,
  'openai-completions': openai,
};

export function imageDriverFor(apiType: ProviderApiType): ImageDriver | null {
  return DRIVERS[apiType] ?? null;
}
