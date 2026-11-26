/** The local build's source checkout within the build's own budget. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLocally } from './local-build';

let directory: string;
let repository: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'hatch-local-')));
  repository = join(directory, 'repo');
  execFileSync('git', ['init', '--quiet', '-b', 'master', repository]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const build = (options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  buildLocally({
    root: repository,
    appId: 'app',
    deploymentId: 'deployment',
    commit: 'a'.repeat(40),
    sdkFiles: [],
    tooling: {
      typescriptVersion: '0.0.0',
      esbuildVersion: '0.0.0',
      pnpmVersion: '0.0.0',
      bufVersion: '0.0.0',
      protocGenEsVersion: '0.0.0',
    },
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 60_000,
  });

/** Git that never answers, as on a stalled disk or network filesystem. */
async function stallGit() {
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n', {
    mode: 0o755,
  });
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
}

describe.skipIf(process.platform === 'win32')('local build checkout', () => {
  it('reports a commit missing from this checkout as unavailable source', async () => {
    await expect(build()).rejects.toMatchObject({
      code: 'source_unavailable',
      exitCode: 6,
    });
  });

  it('stops a stalled checkout at the build deadline', async () => {
    await stallGit();
    const started = Date.now();
    await expect(build({ timeoutMs: 300 })).rejects.toMatchObject({
      code: 'local_build_timeout',
      exitCode: 7,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops a stalled checkout on cancellation', async () => {
    await stallGit();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(build({ signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
      exitCode: 130,
    });
  });
});
