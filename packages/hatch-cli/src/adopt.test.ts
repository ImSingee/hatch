/** Adoption reports why manifest validation could not finish. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adopt } from './adopt';
import type { PlatformClient } from './client';
import type { Profile } from './config';
import { CliError } from './error';

// A local command gets 300 seconds; pnpm gets a fraction of one here.
vi.mock('./process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process')>();
  const command: typeof actual.command = (
    executable,
    args,
    cwd,
    signal,
    allowFailure,
    options,
  ) =>
    actual.command(
      executable,
      args,
      cwd,
      signal,
      allowFailure,
      executable === 'pnpm' ? { ...options, timeoutMs: 200 } : options,
    );
  return { ...actual, command };
});

const bases: string[] = [];

/** An uncommitted Agent checkout of a pnpm-toolchain App, owned by the Run. */
async function checkout(files: Record<string, string>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hatch-adopt-')));
  bases.push(base);
  const session = join(base, 'agents', 'session-1');
  const root = join(session, 'work', 'app');
  await mkdir(root, { recursive: true });
  await mkdir(join(session, 'bundles'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', [
    '-C',
    root,
    'remote',
    'add',
    'origin',
    join(session, 'bundles', 'app-immutable.bundle'),
  ]);
  for (const [name, contents] of Object.entries({
    'manifest.ts': 'export default {};\n',
    'package.json': '{"type":"module","dependencies":{}}',
    'pnpm-lock.yaml':
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n" +
      '  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n',
    ...files,
  })) {
    await writeFile(join(root, name), contents);
  }
  return root;
}

function client(tooling: () => Promise<unknown>): PlatformClient {
  return {
    apps: {
      get: async () => ({ id: 'immutable', createdAt: 'generation' }),
      source: async () => ({
        id: 'immutable',
        masterCommit: null,
        bundleBase64: null,
      }),
    },
    auth: {
      status: async () => ({
        credentialType: 'run',
        context: { sessionId: 'session-1' },
      }),
    },
    sdk: { get: tooling },
  } as unknown as PlatformClient;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    bases.splice(0).map((base) => rm(base, { recursive: true, force: true })),
  );
});

describe('adopt manifest validation', () => {
  const lookup = new CliError('outcome_unknown', 'Request timed out.', 7);
  const failingLookup = () => Promise.reject(lookup);

  it('keeps the code and exit status of a failed platform request', async () => {
    const root = await checkout({});

    await expect(
      adopt(
        root,
        'app',
        'immutable',
        {} as Profile,
        client(failingLookup),
        new AbortController().signal,
      ),
    ).rejects.toBe(lookup);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the code and exit status of a local command that runs out of time',
    async () => {
      const root = await checkout({});
      // A pnpm that never answers, first on PATH and outside the checkout.
      const bin = join(bases.at(-1)!, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nexec sleep 30\n', {
        mode: 0o755,
      });
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
      const tooling = {
        bufVersion: '1.0.0',
        protocGenEsVersion: '2.0.0',
        typescriptVersion: '7.0.2',
        esbuildVersion: '0.28.2',
        pnpmVersion: '12.22.0',
      };

      await expect(
        adopt(
          root,
          'app',
          'immutable',
          {} as Profile,
          client(async () => ({ tooling })),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'local_command_timeout', exitCode: 7 });
    },
  );

  it('reports an invalid source as a manifest mismatch', async () => {
    const root = await checkout({ 'manifest.json': '{}' });

    await expect(
      adopt(
        root,
        'app',
        'immutable',
        {} as Profile,
        client(failingLookup),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'manifest_mismatch', exitCode: 6 });
  });
});
