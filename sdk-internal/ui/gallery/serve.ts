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

const routes: [prefix: string, resolve: (rest: string) => string][] = [
  ['/runtime/', (rest) => path.join(os.homedir(), '.nsh/runtime/web', rest)],
  ['/bundle/', (rest) => path.join(gallery, '.nsh/out', rest)],
  [
    '/fonts/',
    (rest) =>
      path.join(
        fonts(rest.startsWith('nunito') ? 'nunito' : 'jetbrains-mono'),
        rest,
      ),
  ],
  ['/', (rest) => path.join(gallery, 'web', rest || 'index.html')],
];

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
    for (const [prefix, resolve] of routes) {
      if (!url.pathname.startsWith(prefix)) continue;
      const file = resolve(
        decodeURIComponent(url.pathname.slice(prefix.length)),
      );
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
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
