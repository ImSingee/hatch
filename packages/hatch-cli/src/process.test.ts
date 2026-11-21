/** Running out of time is its own failure, never the command's exit status. */
import { describe, expect, it } from 'vitest';
import { command } from './process';

describe('command', () => {
  it.each([false, true])(
    'reports a command that exceeds its limit as a timeout (failure allowed: %s)',
    async (allowFailure) => {
      await expect(
        command(
          process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'],
          process.cwd(),
          new AbortController().signal,
          allowFailure,
          { timeoutMs: 200 },
        ),
      ).rejects.toMatchObject({ code: 'local_command_timeout', exitCode: 7 });
    },
  );
});
