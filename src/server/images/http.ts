/** Server-only: authenticated HTTP delivery of stored platform images. */
import {
  APP_ICON_SIZES,
  readAppIcon,
  type AppIconSize,
} from '~server/apps/icon';
import { parseAppApiPath } from '~server/apps/runtime-api/path';
import {
  authenticateCredential,
  CredentialError,
} from '~server/auth/credentials';
import { RunTokenError } from '~server/agent-runner/run-auth';
import { readCandidate } from './candidates';

const plain = (message: string, status: number) =>
  new Response(message, { status, headers: { 'cache-control': 'no-store' } });

/** Any valid platform credential may read; anonymous requests may not. */
async function denied(request: Request): Promise<Response | null> {
  try {
    await authenticateCredential(request);
    return null;
  } catch (error) {
    if (error instanceof CredentialError || error instanceof RunTokenError)
      return plain('Unauthorized', 401);
    throw error;
  }
}

function png(body: Buffer, cacheControl: string, etag: string): Response {
  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': 'image/png',
      'content-length': String(body.byteLength),
      'cache-control': cacheControl,
      etag,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

/** `GET /api/app/<id>/icon?size=64|128|256&v=<key>` */
export async function handleAppIconRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const rejected = await denied(request);
  if (rejected) return rejected;
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  if (!parsed || !/^\/icon\/?$/.test(parsed.rest))
    return plain('Not found', 404);
  const requested = Number(url.searchParams.get('size') ?? 128);
  const size = APP_ICON_SIZES.find((value) => value === requested);
  if (!size) return plain('Unsupported icon size', 400);
  const icon = await readAppIcon(
    decodeURIComponent(parsed.id),
    size satisfies AppIconSize,
  );
  if (!icon) return plain('Not found', 404);
  const etag = `"${icon.key}-${size}"`;
  // A URL naming the current key never changes content, so it may be cached
  // for good; any other URL must revalidate to pick up a replaced icon.
  const cacheControl =
    url.searchParams.get('v') === icon.key
      ? 'private, max-age=31536000, immutable'
      : 'private, no-cache';
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, {
      status: 304,
      headers: { 'cache-control': cacheControl, etag },
    });
  return png(icon.body, cacheControl, etag);
}

/** `GET /api/images/candidates/<id>` */
export async function handleImageCandidateRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const rejected = await denied(request);
  if (rejected) return rejected;
  const id = /^\/api\/images\/candidates\/([a-f0-9]{32})\/?$/.exec(
    new URL(request.url).pathname,
  )?.[1];
  const body = id ? await readCandidate(id) : null;
  if (!id || !body) return plain('Not found', 404);
  // Content under an id never changes, but it expires within a day.
  return png(body, 'private, max-age=3600, immutable', `"${id}"`);
}
