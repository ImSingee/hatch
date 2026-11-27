/**
 * A Builder job that is stopped (its build canceled, its lease lost, the
 * Builder shutting down) stops the tools it started first. They run in
 * process groups of their own, so killing the job alone would leave them
 * running against a scratch directory that is being removed.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, assert, describe, expect, it } from 'vitest';

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-job-stop-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe.skipIf(process.platform === 'win32')('a stopped Builder job', () => {
  it('stops the tool it is running before it exits', async () => {
    const source = path.join(root, 'source');
    await mkdir(source);
    await writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    await writeFile(
      path.join(source, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
    );
    await writeFile(
      path.join(source, 'manifest.ts'),
      "import { defineAppManifest } from '@hatch/app';\nexport default defineAppManifest({ id: 'stop', name: 'Stop', compatibilityVersion: 2, capabilities: {} });\n",
    );
    // The dependency install never finishes; it records its pid first.
    const tools = path.join(root, 'tools');
    const pidFile = path.join(root, 'tool.pid');
    await mkdir(tools);
    await writeFile(
      path.join(tools, 'pnpm'),
      `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`,
    );
    await chmod(path.join(tools, 'pnpm'), 0o755);
    const workDir = path.join(root, 'scratch');
    await mkdir(workDir);
    const request = path.join(root, 'request.json');
    await writeFile(
      request,
      JSON.stringify({
        appId: 'stop',
        deploymentId: 'dep-stop',
        commit: 'c'.repeat(40),
        sourceDir: source,
        outDir: path.join(root, 'package'),
        workDir,
        sdkDigest: '0'.repeat(64),
      }),
    );
    const job = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/builder/main.ts', '--job', request],
      {
        env: {
          ...process.env,
          PATH: `${tools}${path.delimiter}${process.env.PATH}`,
          HATCH_DATA_DIR: path.join(root, 'data'),
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    job.stdout.on('data', (data) => (output += data));
    job.stderr.on('data', (data) => (output += data));
    const started = await waitFor(
      async () => Boolean(await readFile(pidFile, 'utf8').catch(() => '')),
      60_000,
    );
    assert.isTrue(started, output);
    const tool = Number((await readFile(pidFile, 'utf8')).trim());
    expect(alive(tool)).toBe(true);

    try {
      const exited = once(job, 'close');
      job.kill('SIGTERM');
      await exited;
      assert.isTrue(await waitFor(async () => !alive(tool), 5_000), output);
    } finally {
      // A failing run leaves nothing behind either.
      if (alive(tool)) process.kill(tool, 'SIGKILL');
    }
  }, 120_000);
});
