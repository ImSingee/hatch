/**
 * The shared NSH web runtime is served without a session from a request
 * path, so it serves only content-named runtime files of a version.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NSH_VERSION } from './nsh-toolchain';

let dataDir: string;
let store: typeof import('./runtime-store');

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-nsh-runtime-'));
  vi.stubEnv('HATCH_DATA_DIR', dataDir);
  vi.resetModules();
  store = await import('./runtime-store');
  const source = path.join(dataDir, 'source.js');
  await fs.writeFile(source, 'export const runtime = 1;');
  await store.publishRuntimeFile('0.6.1', 'nsh.0123456789.js', source);
  await fs.writeFile(source + '.br', 'compressed');
  await store.publishRuntimeFile(
    '0.6.1',
    'nsh.0123456789.js.br',
    source + '.br',
  );
  await fs.writeFile(path.join(dataDir, 'secret.txt'), 'not runtime');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('NSH runtime store', () => {
  it('serves a published file immutable, precompressed when accepted', async () => {
    const plain = await store.serveNshRuntimeFile(
      '0.6.1',
      'nsh.0123456789.js',
      null,
    );
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe('export const runtime = 1;');
    expect(plain.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    const brotli = await store.serveNshRuntimeFile(
      '0.6.1',
      'nsh.0123456789.js',
      'gzip, br',
    );
    expect(brotli.headers.get('content-encoding')).toBe('br');
    expect(brotli.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    // Quality zero excludes a coding.
    const refused = await store.serveNshRuntimeFile(
      '0.6.1',
      'nsh.0123456789.js',
      'gzip, br;q=0',
    );
    expect(refused.headers.get('content-encoding')).toBeNull();
    expect(await refused.text()).toBe('export const runtime = 1;');
    // Excluding the plain file leaves only Brotli, or nothing at all.
    const brotliOnly = await store.serveNshRuntimeFile(
      '0.6.1',
      'nsh.0123456789.js',
      'br, identity;q=0',
    );
    expect(brotliOnly.headers.get('content-encoding')).toBe('br');
    for (const header of ['gzip, identity;q=0', 'gzip, *;q=0']) {
      const none = await store.serveNshRuntimeFile(
        '0.6.1',
        'nsh.0123456789.js',
        header,
      );
      expect(none.status).toBe(406);
    }
  });

  it('refuses anything that is not a runtime file of a version', async () => {
    for (const [version, file] of [
      // Both would reach `<data>/secret.txt` without the name guard.
      ['0.6.1', '../../../secret.txt'],
      ['0.6.1', 'browser.0123456789/../../../../secret.txt'],
      ['..', 'nsh.0123456789.js'],
      ['0.6', 'nsh.0123456789.js'],
      ['0.6.1', 'nsh.0123456789.js.br'],
      ['0.6.1', 'secret.txt'],
      ['0.6.2', 'nsh.0123456789.js'],
    ]) {
      const response = await store.serveNshRuntimeFile(version, file, 'br');
      expect(response.status).toBe(404);
    }
  });

  it('keeps a published name immutable', async () => {
    const other = path.join(dataDir, 'other.js');
    await fs.writeFile(other, 'export const runtime = 2;');
    await expect(
      store.publishRuntimeFile('0.6.1', 'nsh.0123456789.js', other),
    ).rejects.toThrow(/differs from the one already published/);
    await expect(
      store.publishRuntimeFile('0.6.1', '../escape.js', other),
    ).rejects.toThrow(/Not an NSH runtime file/);
  });

  it('serves deployments of an earlier NSH next to the pinned one', async () => {
    // A deployment's page names the runtime of the NSH it was built with;
    // publishing the pinned release's files leaves the earlier ones served.
    const pinned = path.join(dataDir, 'pinned.wasm');
    await fs.writeFile(pinned, 'pinned engine');
    await store.publishRuntimeFile(
      NSH_VERSION,
      'nsh-pickers.0123456789.wasm',
      pinned,
    );
    const earlier = await store.serveNshRuntimeFile(
      '0.6.1',
      'nsh.0123456789.js',
      null,
    );
    expect(await earlier.text()).toBe('export const runtime = 1;');
    const current = await store.serveNshRuntimeFile(
      NSH_VERSION,
      'nsh-pickers.0123456789.wasm',
      null,
    );
    expect(await current.text()).toBe('pinned engine');
    expect(current.headers.get('content-type')).toBe('application/wasm');
  });
});
