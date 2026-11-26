import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// shell-env resolves its data paths at module load.
const dataDir = await mkdtemp(path.join(tmpdir(), 'hatch-shell-env-test-'));
vi.stubEnv('HATCH_DATA_DIR', dataDir);
const { agentShellEnv, agentTrustedPath } = await import('./shell-env');
const { REPO_ROOT } = await import('./paths');
const { NSH_VERSION, resetNshBinary } =
  await import('~server/apps/native/nsh-toolchain');

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

function commandEnv(sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(agentShellEnv(sessionId))) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

describe('Agent shell environment', () => {
  it('commits in a fresh checkout as the Agent, never as the host user', async () => {
    vi.stubEnv('GIT_AUTHOR_NAME', 'Host User');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'host@example.test');
    const repo = await mkdtemp(path.join(dataDir, 'repo-'));
    const env = commandEnv('identity-session');
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    expect(git('init', '-q').status).toBe(0);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    expect(git('add', '.').status).toBe(0);

    const commit = git('commit', '-qm', 'agent work');
    expect(commit.stderr).toBe('');
    expect(commit.status).toBe(0);
    expect(
      git('log', '-1', '--format=%an <%ae> / %cn <%ce>').stdout.trim(),
    ).toBe('Hatch Agent <agent@hatch.local> / Hatch Agent <agent@hatch.local>');
  });

  it('runs the pinned nsh a deploy uses, with the platform TypeScript', async () => {
    // Outside the workspace: the Agent PATH never lists a directory in it.
    const release = await mkdtemp(path.join(tmpdir(), 'hatch-nsh-release-'));
    const bin = path.join(release, 'bin');
    await mkdir(bin, { recursive: true });
    // A versioned name: the Agent still runs it as `nsh`.
    const nsh = path.join(bin, 'nsh-pinned');
    await writeFile(nsh, `#!/bin/sh\necho "nsh ${NSH_VERSION} (test)"\n`);
    await chmod(nsh, 0o755);
    vi.stubEnv('HATCH_NSH_BIN', nsh);
    resetNshBinary();
    try {
      const env = commandEnv('nsh-session');
      const found = spawnSync('sh', ['-c', 'command -v nsh'], {
        env,
        encoding: 'utf8',
      });
      const command = found.stdout.trim();
      expect(realpathSync(command)).toBe(realpathSync(nsh));
      const version = spawnSync('nsh', ['--version'], {
        env,
        encoding: 'utf8',
      });
      expect(version.stdout).toContain(`nsh ${NSH_VERSION}`);
      expect(env.NSH_TSC).toBe(
        path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      );
    } finally {
      vi.stubEnv('HATCH_NSH_BIN', '');
      resetNshBinary();
      await rm(release, { recursive: true, force: true });
    }
  });

  it.runIf(
    existsSync(path.join(REPO_ROOT, 'packages/hatch-cli/dist/main.mjs')),
  )('puts the development hatch CLI shim on the Agent PATH', () => {
    expect(agentTrustedPath().split(path.delimiter)).toContain(
      path.join(REPO_ROOT, 'packages', 'hatch-cli', 'bin'),
    );
  });
});
