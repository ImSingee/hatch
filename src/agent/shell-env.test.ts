import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// shell-env resolves its data paths at module load.
const dataDir = await mkdtemp(path.join(tmpdir(), 'hatch-shell-env-test-'));
vi.stubEnv('HATCH_DATA_DIR', dataDir);
const { agentShellEnv, agentTrustedPath } = await import('./shell-env');
const { REPO_ROOT } = await import('./paths');

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

  it.runIf(
    existsSync(path.join(REPO_ROOT, 'packages/hatch-cli/dist/main.mjs')),
  )('puts the development hatch CLI shim on the Agent PATH', () => {
    expect(agentTrustedPath().split(path.delimiter)).toContain(
      path.join(REPO_ROOT, 'packages', 'hatch-cli', 'bin'),
    );
  });
});
