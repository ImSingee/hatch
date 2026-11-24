/**
 * The shared NSH web runtime is served without a session from a request
 * path, so it serves only content-named runtime files of a version.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
  });

  it('refuses anything that is not a runtime file of a version', async () => {
    for (const [version, file] of [
      ['0.6.1', '../../secret.txt'],
      ['0.6.1', 'browser.0123456789/../../../secret.txt'],
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
});
