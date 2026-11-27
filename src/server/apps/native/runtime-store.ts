/**
 * Server-only: the shared NSH web runtime the player pages load from
 * `/api/app-runtime/nsh/<version>/`. `nsh package --target web` links each
 * App its own engine, but every file it writes is named by its content, so
 * Apps with the same engine share the download. Files are written once and
 * never change; a name that already exists must hold the same bytes.
 *
 * Builds no longer run on the platform, so the runtime files of a package
 * are untrusted. They are published as a runtime set under
 * `sets/<digest>/`, where the digest covers the name and bytes of every
 * file of the set: a package can never replace or add a file another
 * App's player loads, and identical engines still share one set.
 * Deployments built before sets keep loading the flat directory.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT } from '~agent/paths';
import { isRuntimeFileName } from './runtime-names';

export { isRuntimeFileName };

export const NSH_RUNTIME_ROUTE = '/api/app-runtime/nsh';

/** `/api/app-runtime/nsh/<version>/`, where a player page loads its runtime. */
export function nshRuntimeBase(version: string): string {
  return `${NSH_RUNTIME_ROUTE}/${version}/`;
}

export function nshRuntimeDir(version: string): string {
  return path.join(WORKSPACE_ROOT, 'app-runtime', 'nsh', version);
}

const VERSION = /^\d+\.\d+\.\d+$/;
const RUNTIME_SET = /^sets\/([0-9a-f]{64})\/(.+)$/;

/** Whether `relative` names a servable runtime file, flat or in a set. */
function isServableRuntimePath(relative: string): boolean {
  const set = RUNTIME_SET.exec(relative);
  return isRuntimeFileName(set ? set[2] : relative);
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
  if (!VERSION.test(version) || !isServableRuntimePath(relative)) {
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
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o444);
    // A concurrent deploy may publish the same name; both hold equal bytes.
    await fs.rename(temporary, target);
  } finally {
    // Gone after a successful rename; a leftover after a failure.
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function listRuntimeFiles(
  root: string,
  relative = '',
): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listRuntimeFiles(root, child)));
    } else if (entry.isFile()) {
      out.push(child);
    } else {
      throw new Error(`Not an NSH runtime file: ${child}`);
    }
  }
  return out;
}

/**
 * Publish every file below `root` as one runtime set and return the base
 * URL its player loads from. `required` names files the player references;
 * each must be part of the set.
 */
export async function publishRuntimeSet(
  version: string,
  root: string,
  required: readonly string[],
): Promise<string> {
  if (!VERSION.test(version)) {
    throw new Error(`Not an NSH version: ${version}`);
  }
  const files = (await listRuntimeFiles(root)).sort();
  if (files.length === 0) throw new Error('The package has no NSH runtime.');
  const digest = createHash('sha256');
  for (const file of files) {
    if (!isRuntimeFileName(file)) {
      throw new Error(`Not an NSH runtime file: ${file}`);
    }
    digest.update(`${file}\0${await sha256(path.join(root, file))}\n`);
  }
  for (const file of required) {
    if (!files.includes(file)) {
      throw new Error(`The NSH runtime is missing ${file}.`);
    }
  }
  const set = `sets/${digest.digest('hex')}`;
  for (const file of files) {
    await publishRuntimeFile(
      version,
      `${set}/${file}`,
      path.join(root, ...file.split('/')),
    );
  }
  return `${nshRuntimeBase(version)}${set}/`;
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
/**
 * Whether an `Accept-Encoding` header accepts a content coding: listed by
 * name or `*`, with a quality above zero (RFC 9110, section 12.5.3).
 */
function acceptedCodings(header: string | null): (coding: string) => boolean {
  const quality = new Map<string, number>();
  for (const part of (header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params
      .map((param) => /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param)?.[1])
      .find((value) => value !== undefined);
    quality.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  return (coding) => {
    // `identity` is acceptable unless excluded by name or by `*;q=0`.
    const fallback = coding === 'identity' ? 1 : 0;
    const q = quality.get(coding) ?? quality.get('*') ?? fallback;
    return Number.isFinite(q) && q > 0;
  };
}

export async function serveNshRuntimeFile(
  version: string,
  relative: string,
  acceptEncoding: string | null,
): Promise<Response> {
  if (!VERSION.test(version) || !isServableRuntimePath(relative)) {
    return new Response('Not found', { status: 404 });
  }
  if (/\.(?:br|gz)$/.test(relative)) {
    return new Response('Not found', { status: 404 });
  }
  const file = path.join(nshRuntimeDir(version), ...relative.split('/'));
  const accepts = acceptedCodings(acceptEncoding);
  const variants: [string, string | null][] = [
    ...(accepts('br') ? [[`${file}.br`, 'br'] as [string, string]] : []),
    ...(accepts('gzip') ? [[`${file}.gz`, 'gzip'] as [string, string]] : []),
    ...(accepts('identity') ? [[file, null] as [string, null]] : []),
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
  // The file exists, but the client accepts none of its representations.
  const exists = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  return exists
    ? new Response('Not acceptable', {
        status: 406,
        headers: { vary: 'accept-encoding' },
      })
    : new Response('Not found', { status: 404 });
}
