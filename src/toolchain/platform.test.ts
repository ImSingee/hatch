/** Authored code never runs with the platform's own OS identity in production. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolchainCommand } from '../source-toolchain';

// What the sandbox wraps a command in: nothing, the macOS file profile (same
// identity), or setpriv (another identity).
const sandbox = vi.hoisted(() => ({
  wrapper: undefined as 'sandbox-exec' | 'setpriv' | undefined,
}));
const spawned = vi.hoisted(() => ({ calls: [] as [string, string[]][] }));

vi.mock('../agent/shell-sandbox', () => ({
  sandboxSwitchesIdentity: () => sandbox.wrapper === 'setpriv',
  sandboxSpawn: ([command, ...args]: [string, ...string[]]) =>
    sandbox.wrapper
      ? {
          command: `/usr/bin/${sandbox.wrapper}`,
          args: ['--', command, ...args],
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
  it.each([undefined, 'sandbox-exec'] as const)(
    'refuses to evaluate authored code in production under its own identity (wrapper: %s)',
    async (wrapper) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('HATCH_ALLOW_UNSANDBOXED', '');
      sandbox.wrapper = wrapper;

      await expect((await context()).run(EVALUATION)).rejects.toThrow(
        /cannot switch to the sandbox identity/,
      );
      expect(spawned.calls).toEqual([]);
    },
  );

  it('evaluates under its own identity in production once the operator accepts unsandboxed subprocesses', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HATCH_ALLOW_UNSANDBOXED', 'true');
    sandbox.wrapper = undefined;

    await (await context()).run(EVALUATION);

    expect(spawned.calls).toEqual([[process.execPath, EVALUATION.args]]);
  });

  it('evaluates authored code through the sandbox identity and other tools directly', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    sandbox.wrapper = 'setpriv';
    const { run } = await context();

    await run(EVALUATION);
    await run({ tool: 'pnpm', args: ['fetch'], step: 'install' });

    expect(spawned.calls).toEqual([
      ['/usr/bin/setpriv', ['--', process.execPath, ...EVALUATION.args]],
      ['pnpm', ['fetch']],
    ]);
  });
});
