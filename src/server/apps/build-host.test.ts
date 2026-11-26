/**
 * A sandboxed build host runs every tool with the sandbox's own home: buf
 * never reads the host user's configuration, which the sandbox identity
 * cannot read on the Builder (it failed Connect codegen there).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { platformBuildHost } from './build-host';

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-build-host-')),
);
afterAll(() => fs.rm(root, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

it('runs buf with the sandbox home, never the host user configuration', async () => {
  // The host user's buf configuration is unreadable YAML, so any buf that
  // reads it fails.
  const hostHome = path.join(root, 'host-home');
  await fs.mkdir(path.join(hostHome, '.config', 'buf'), { recursive: true });
  await fs.writeFile(
    path.join(hostHome, '.config', 'buf', 'config.yaml'),
    'version: [unterminated',
  );
  vi.stubEnv('HOME', hostHome);
  vi.stubEnv('XDG_CONFIG_HOME', '');

  const module = path.join(root, 'proto');
  await fs.mkdir(module);
  await fs.writeFile(path.join(module, 'buf.yaml'), 'version: v2\n');
  await fs.writeFile(
    path.join(module, 'a.proto'),
    'syntax = "proto3";\npackage a.v1;\nmessage A {}\n',
  );
  const args = ['build', '-o', path.join(root, 'image.binpb')];

  const unsandboxed = platformBuildHost({ sdkDigest: 'test' });
  expect((await unsandboxed.runBuf(args, module)).code).not.toBe(0);

  const home = path.join(root, 'sandbox-home');
  await fs.mkdir(home);
  const sandboxed = platformBuildHost({
    sdkDigest: 'test',
    sandbox: { home, pnpmStoreDir: path.join(root, 'store') },
  });
  const result = await sandboxed.runBuf(args, module);
  expect(result.output).toBe('');
  expect(result.code).toBe(0);
});
