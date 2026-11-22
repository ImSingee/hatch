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
  });

  it('rejects incomplete, unknown or misplaced input before any request', () => {
    expect(rejected('preferences')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'list')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'set')).toMatch(/--agent-message-mode/);
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
  });
});
