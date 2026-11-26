import { describe, expect, it } from 'vitest';
import { parsePreferencesCommand } from './preferences';

const command = (...args: string[]) => parsePreferencesCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parsePreferencesCommand(args, 0);
  } catch (error) {
    return (error as { code?: string; message?: string }).message;
  }
  return 'accepted';
};

describe('preferences command arguments', () => {
  it('maps get and set to one explicit operation', () => {
    expect(command('preferences', 'get', '--json')).toEqual({ kind: 'get' });
    expect(
      command('preferences', 'set', '--agent-message-mode', 'queue'),
    ).toEqual({ kind: 'set', agentMessageMode: 'queue' });
    expect(
      command('preferences', 'set', '--agent-message-mode=steer', '--json'),
    ).toEqual({ kind: 'set', agentMessageMode: 'steer' });
    expect(
      command('preferences', 'set', '--background-app-minutes', '15'),
    ).toEqual({ kind: 'set', backgroundAppMinutes: 15 });
    expect(
      command(
        'preferences',
        'set',
        '--agent-message-mode',
        'queue',
        '--background-app-minutes=1440',
      ),
    ).toEqual({
      kind: 'set',
      agentMessageMode: 'queue',
      backgroundAppMinutes: 1440,
    });
  });

  it('rejects incomplete, unknown or misplaced input before any request', () => {
    expect(rejected('preferences')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'list')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'set')).toMatch(/--background-app-minutes/);
    for (const minutes of ['0', '1441', '1.5', '-3', '', 'ten'])
      expect(
        rejected('preferences', 'set', `--background-app-minutes=${minutes}`),
      ).toMatch(/whole number from 1 to 1440/);
    expect(
      rejected(
        'preferences',
        'set',
        '--background-app-minutes',
        '5',
        '--background-app-minutes=6',
      ),
    ).toMatch(/only once/);
    expect(
      rejected('preferences', 'set', '--agent-message-mode', 'later'),
    ).toMatch(/queue or steer/);
    expect(rejected('preferences', 'set', '--agent-message-mode', '')).toMatch(
      /queue or steer/,
    );
    expect(
      rejected('preferences', 'get', '--agent-message-mode', 'queue'),
    ).toMatch(/Invalid arguments/);
    expect(rejected('preferences', 'get', 'extra')).toMatch(/positional/);
    for (const [first, second] of [
      ['queue', 'steer'],
      ['steer', 'queue'],
    ])
      expect(
        rejected(
          'preferences',
          'set',
          '--agent-message-mode',
          first,
          `--agent-message-mode=${second}`,
        ),
      ).toMatch(/only once/);
  });
});
