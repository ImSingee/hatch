import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { appCompatibilityRuntimeMessage } from '~/app-compatibility';
import { appBuildDir, deploymentArtifactDir } from '~agent/paths';
import { liveAppDeployment } from './access';
import { readLiveBuildFile } from './build-identity';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
};

/**
 * The native player page's policy: NSH's web runtime needs WebAssembly
 * compilation and blob/data images; the App reaches the network only through
 * the page's same-origin host calls, and nothing else may load or frame it.
 */
export const NATIVE_PLAYER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * `_deployments/<deployment>/<file>`: a file of one deployment's frontend.
 * A native App's player loads its module, chunks and assets this way, so a
 * deployment activated while it starts (or runs) cannot pull those files from
 * under it.
 */
const PINNED_FILE = /^_deployments\/([0-9a-z]{1,64})\/(.+)$/;

/** A file from a deployment's immutable artifact, cached for good. */
async function servePinnedFile(
  id: string,
  deploymentId: string,
  rel: string,
): Promise<Response> {
  const appDir = path.join(deploymentArtifactDir(id, deploymentId), 'app');
  const filePath = path.normalize(path.join(appDir, rel));
  if (!filePath.startsWith(appDir + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  let data: Buffer;
  try {
    const handle = await fs.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!(await handle.stat()).isFile()) throw new Error('not a file');
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return new Response('Not found', { status: 404 });
  }
  return new Response(new Uint8Array(data), {
    headers: {
      'content-type':
        CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      // Never changes; private because the App's frame needs a session.
      'cache-control': 'private, max-age=31536000, immutable',
      // Only native players use these paths; the policy applies whatever
      // runtime the live deployment has now.
      'content-security-policy': NATIVE_PLAYER_CSP,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Serve a static file from an app's built `app/` directory for the human-facing
 * `/app/<slug>` page and the id-based technical `/api/app/:id/app/*` route.
 * Guards against path traversal outside the app directory.
 */
export async function serveAppAppFile(
  id: string,
  rawRel: string,
): Promise<Response> {
  // Don't serve a retired/never-deployed app's bundle from leftover build files
  // via a stale direct URL: require a live, non-archived frontend deployment.
  const live = await liveAppDeployment(id, 'frontend');
  if (!live) {
    return new Response('Not found', { status: 404 });
  }
  if (live.state === 'unsupported') {
    return new Response(appCompatibilityRuntimeMessage(live.compatibility), {
      status: 503,
    });
  }
  let rel = decodeURIComponent(rawRel || '');
  if (rel === '' || rel.endsWith('/')) {
    rel += 'index.html';
  }
  const pinned = PINNED_FILE.exec(rel);
  if (pinned) return servePinnedFile(id, pinned[1], pinned[2]);

  const appDir = path.join(appBuildDir(id), 'app');
  const filePath = path.normalize(path.join(appDir, rel));
  if (filePath !== appDir && !filePath.startsWith(appDir + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }

  const result = await readLiveBuildFile(
    id,
    live.deploymentId,
    path.relative(appBuildDir(id), filePath),
  );
  if (!result.ok && result.reason === 'unavailable') {
    return new Response('App deployment is being finalized.', {
      status: 503,
      headers: { 'retry-after': '1' },
    });
  }
  if (!result.ok) {
    return new Response('Not found', { status: 404 });
  }
  const ext = path.extname(filePath);
  const native = live.manifest.app?.runtime === 'native';
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  };
  if (native) {
    // Every response of a native App's frame carries the policy, so a file
    // opened directly (an SVG, a page) gets no more than the player does.
    headers['content-security-policy'] = NATIVE_PLAYER_CSP;
    headers['x-content-type-options'] = 'nosniff';
  }
  return new Response(new Uint8Array(result.data), { headers });
}
