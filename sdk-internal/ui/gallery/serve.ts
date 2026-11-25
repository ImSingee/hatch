/**
 * Serves the gallery's web player for local checks:
 *
 *   node_modules/.bin/tsx sdk-internal/ui/gallery/serve.ts [port]
 *
 * after `nsh build app/main.tsx --release` in this directory. The runtime
 * comes from the local NSH install (`~/.nsh/runtime/web`).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gallery = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(gallery, '../../..');
const fonts = (pkg: string) =>
  path.join(repo, 'node_modules/@fontsource-variable', pkg, 'files');

/** Each route serves files below its own root, and nothing outside it. */
const routes: [prefix: string, root: (rest: string) => string][] = [
  ['/runtime/', () => path.join(os.homedir(), '.nsh/runtime/web')],
  ['/bundle/', () => path.join(gallery, '.nsh/out')],
  [
    '/fonts/',
    (rest) => fonts(rest.startsWith('nunito') ? 'nunito' : 'jetbrains-mono'),
  ],
  ['/', () => path.join(gallery, 'web')],
];

/** The file a request names below `root`, or null when its path leaves the
 * root (`..`, encoded separators) or is not a file. */
function fileBelow(root: string, rest: string): string | null {
  const file = path.resolve(root, rest || 'index.html');
  if (!file.startsWith(root + path.sep)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

const port = Number(process.argv[2] ?? 8791);
http
  .createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    for (const [prefix, root] of routes) {
      if (!url.pathname.startsWith(prefix)) continue;
      let rest: string;
      try {
        rest = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const file = fileBelow(path.resolve(root(rest)), rest);
      if (!file) continue;
      response.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(fs.readFileSync(file));
      return;
    }
    response.writeHead(404).end();
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`gallery on http://127.0.0.1:${port}/`);
  });
