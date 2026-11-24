/**
 * Server-only: the shared NSH web runtime the player pages load from
 * `/api/app-runtime/nsh/<version>/`. `nsh package --target web` links each
 * App its own engine, but every file it writes is named by its content, so
 * deploys publish their runtime files into one content-addressed directory
 * per NSH version and Apps with the same engine share the download. Files
 * are written once and never change; a name that already exists must hold
 * the same bytes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT } from '~agent/paths';

export const NSH_RUNTIME_ROUTE = '/api/app-runtime/nsh';

/** `/api/app-runtime/nsh/<version>/`, where a player page loads its runtime. */
export function nshRuntimeBase(version: string): string {
  return `${NSH_RUNTIME_ROUTE}/${version}/`;
}

export function nshRuntimeDir(version: string): string {
  return path.join(WORKSPACE_ROOT, 'app-runtime', 'nsh', version);
}

const VERSION = /^\d+\.\d+\.\d+$/;
// Every runtime file `nsh package` writes carries a content digest in its
// name or in its directory's (`browser.<digest>/runtime.js`).
const RUNTIME_FILE =
  /^(?:browser\.[0-9a-f]{8,}\/[\w.-]+|[\w-]+\.[0-9a-f]{8,}\.(?:js|wasm|bin|css))(?:\.(?:br|gz))?$/;

export function isRuntimeFileName(relative: string): boolean {
  return RUNTIME_FILE.test(relative) && !relative.includes('..');
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

/** Publish one packaged runtime file; idempotent for identical bytes. */
export async function publishRuntimeFile(
  version: string,
  relative: string,
  source: string,
): Promise<void> {
  if (!VERSION.test(version) || !isRuntimeFileName(relative)) {
    throw new Error(`Not an NSH runtime file: ${relative}`);
  }
  const root = nshRuntimeDir(version);
  const target = path.join(root, ...relative.split('/'));
  try {
    if ((await sha256(target)) === (await sha256(source))) return;
    throw new Error(
      `NSH runtime file ${relative} differs from the one already published ` +
        `for ${version}; the pinned NSH install has changed.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.copyFile(source, temporary);
  await fs.chmod(temporary, 0o444);
  // A concurrent deploy may publish the same name; both hold equal bytes.
  await fs.rename(temporary, target);
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve a runtime file. The runtime is NSH's own open-source code, the same
 * for every viewer, so it needs no session; names change with content, so
 * responses are immutable. Precompressed copies are used when accepted.
 */
export async function serveNshRuntimeFile(
  version: string,
  relative: string,
  acceptEncoding: string | null,
): Promise<Response> {
  if (!VERSION.test(version) || !isRuntimeFileName(relative)) {
    return new Response('Not found', { status: 404 });
  }
  if (/\.(?:br|gz)$/.test(relative)) {
    return new Response('Not found', { status: 404 });
  }
  const file = path.join(nshRuntimeDir(version), ...relative.split('/'));
  const accepts = (acceptEncoding ?? '').toLowerCase();
  const variants: [string, string | null][] = [
    ...(accepts.includes('br')
      ? [[`${file}.br`, 'br'] as [string, string]]
      : []),
    ...(accepts.includes('gzip')
      ? [[`${file}.gz`, 'gzip'] as [string, string]]
      : []),
    [file, null],
  ];
  for (const [candidate, encoding] of variants) {
    let data: Buffer;
    try {
      data = await fs.readFile(candidate);
    } catch {
      continue;
    }
    const headers: Record<string, string> = {
      'content-type':
        CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      vary: 'accept-encoding',
      'x-content-type-options': 'nosniff',
    };
    if (encoding) headers['content-encoding'] = encoding;
    return new Response(new Uint8Array(data), { headers });
  }
  return new Response('Not found', { status: 404 });
}
