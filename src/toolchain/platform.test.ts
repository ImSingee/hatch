/** Authored code never runs with the platform's own OS identity in production. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolchainCommand } from '../source-toolchain';

const sandbox = vi.hoisted(() => ({ confined: false }));
const spawned = vi.hoisted(() => ({ calls: [] as [string, string[]][] }));

vi.mock('../agent/shell-sandbox', () => ({
  sandboxSpawn: ([command, ...args]: [string, ...string[]]) =>
    sandbox.confined
      ? {
          command: '/usr/bin/setpriv',
          args: ['--reuid=sandbox', '--', command, ...args],
        }
      : { command, args },
}));
vi.mock('../server/subprocess', () => ({
  run: async (command: string, args: string[]) => {
    spawned.calls.push([command, args]);
    return { code: 0, stdout: '', stderr: '', output: '' };
  },
}));

const EVALUATION: ToolchainCommand = {
  tool: 'node',
  args: ['--permission', '--input-type=module', '-'],
  step: 'manifest',
};

async function context() {
  const { platformToolchainContext } = await import('./platform');
  return platformToolchainContext('app', '/source', []);
}

afterEach(() => {
  vi.unstubAllEnvs();
  spawned.calls.length = 0;
});

describe('platform toolchain runner', () => {
  it('refuses to evaluate authored code in production when it cannot leave its own identity', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    sandbox.confined = false;

    await expect((await context()).run(EVALUATION)).rejects.toThrow(
      /cannot switch to the sandbox identity/,
    );
    expect(spawned.calls).toEqual([]);
  });

  it('evaluates authored code through the sandbox identity and other tools directly', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    sandbox.confined = true;
    const { run } = await context();

    await run(EVALUATION);
    await run({ tool: 'pnpm', args: ['fetch'], step: 'install' });

    expect(spawned.calls).toEqual([
      [
        '/usr/bin/setpriv',
        ['--reuid=sandbox', '--', process.execPath, ...EVALUATION.args],
      ],
      ['pnpm', ['fetch']],
    ]);
  });
});
