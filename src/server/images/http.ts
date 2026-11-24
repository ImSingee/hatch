/** Server-only: authenticated HTTP delivery of stored platform images. */
import type { UserAvatarSize } from '~lib/user-avatar';
import { readAppIcon, type AppIconSize } from '~server/apps/icon';
import { parseAppApiPath } from '~server/apps/runtime-api/path';
import {
  authenticateCredential,
  CredentialError,
} from '~server/auth/credentials';
import { RunTokenError } from '~server/agent-runner/run-auth';
import { db } from '~/db';
import { readUserAvatar } from '~server/user-avatar-store';
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

const STORED_SIZES = [64, 128, 256] as const;
type StoredSize = (typeof STORED_SIZES)[number];

/**
 * Deliver one size of a stored square image (App icon, user avatar) from
 * `?size=64|128|256` (default 128), versioned by `?v=<key>`.
 */
async function storedSquareImage(
  request: Request,
  read: (size: StoredSize) => Promise<{ key: string; body: Buffer } | null>,
): Promise<Response> {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('size') ?? 128);
  const size = STORED_SIZES.find((value) => value === requested);
  if (!size) return plain('Unsupported image size', 400);
  const image = await read(size);
  if (!image) return plain('Not found', 404);
  const etag = `"${image.key}-${size}"`;
  // A URL naming the current key never changes content, so it may be cached
  // for good; any other URL must revalidate to pick up a replaced image.
  const cacheControl =
    url.searchParams.get('v') === image.key
      ? 'private, max-age=31536000, immutable'
      : 'private, no-cache';
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, {
      status: 304,
      headers: { 'cache-control': cacheControl, etag },
    });
  return png(image.body, cacheControl, etag);
}

/** `GET /api/app/<id>/icon?size=64|128|256&v=<key>` */
export async function handleAppIconRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const rejected = await denied(request);
  if (rejected) return rejected;
  const parsed = parseAppApiPath(new URL(request.url).pathname);
  if (!parsed || !/^\/icon\/?$/.test(parsed.rest))
    return plain('Not found', 404);
  return storedSquareImage(request, (size) =>
    readAppIcon(decodeURIComponent(parsed.id), size satisfies AppIconSize),
  );
}

/** `GET /api/users/<id>/avatar?size=64|128|256&v=<key>` */
export async function handleUserAvatarRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const rejected = await denied(request);
  if (rejected) return rejected;
  const encoded = /^\/api\/users\/([^/]+)\/avatar\/?$/.exec(
    new URL(request.url).pathname,
  )?.[1];
  let userId: string | null = null;
  try {
    userId = encoded ? decodeURIComponent(encoded) : null;
  } catch {
    userId = null;
  }
  if (!userId) return plain('Not found', 404);
  const id = userId;
  return storedSquareImage(request, (size) =>
    readUserAvatar(id, size satisfies UserAvatarSize),
  );
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

/**
 * `GET /api/images/app-icons`: icon key per App id, for Apps that have one.
 * Plain HTTP rather than a Server Function so the App tile component, used
 * all over the UI, depends on no server module.
 */
export async function handleAppIconIndexRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const rejected = await denied(request);
  if (rejected) return rejected;
  const rows = await db.query.apps.findMany({
    columns: { id: true, icon: true },
  });
  return Response.json(
    Object.fromEntries(
      rows.flatMap((row) => (row.icon ? [[row.id, row.icon]] : [])),
    ),
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
