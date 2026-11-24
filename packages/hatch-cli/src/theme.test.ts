import { describe, expect, it } from 'vitest';
import tokens from '../../hatch-design-tokens/tokens.json';
import { parseThemeCommand } from './theme';

const command = (...args: string[]) => parseThemeCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parseThemeCommand(args, 0);
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  return { code: 'accepted' };
};

describe('theme command arguments', () => {
  it('maps get and set, accepting every accent the tokens define', () => {
    expect(command('theme', 'get')).toEqual({ kind: 'get' });
    for (const accent of Object.keys(tokens.accents))
      expect(command('theme', 'set', '--accent', accent)).toEqual({
        kind: 'set',
        accent,
      });
  });

  it('sets dock names on their own or with the accent, leaving out what is not given', () => {
    expect(command('theme', 'set', '--dock-labels')).toEqual({
      kind: 'set',
      dockLabels: true,
    });
    expect(command('theme', 'set', '--no-dock-labels')).toEqual({
      kind: 'set',
      dockLabels: false,
    });
    expect(
      command('theme', 'set', '--accent', 'teal', '--no-dock-labels'),
    ).toEqual({ kind: 'set', accent: 'teal', dockLabels: false });
  });

  it('rejects unusable input before any request and names the flag', () => {
    for (const args of [
      ['theme'],
      ['theme', 'clear'],
      ['theme', 'get', 'extra'],
      ['theme', 'get', '--accent', 'teal'],
      ['theme', 'set'],
      ['theme', 'set', 'teal'],
      ['theme', 'set', '--accent', ''],
      ['theme', 'set', '--accent', 'Teal'],
      ['theme', 'set', '--accent', 'orange'],
      // Inherited object keys are not accents.
      ['theme', 'set', '--accent', 'toString'],
      ['theme', 'set', '--dock-labels', '--no-dock-labels'],
      ['theme', 'set', '--dock-labels=yes'],
      ['theme', 'get', '--dock-labels'],
    ])
      expect({ args, code: rejected(...args).code }).toEqual({
        args,
        code: 'invalid_arguments',
      });
    // Every rejection names the flag to fix, including the ones Node's
    // argument parser raises before the command sees the flags.
    for (const [args, message] of [
      [['theme', 'set'], 'Supply --accent, --dock-labels or --no-dock-labels'],
      [
        ['theme', 'set', '--dock-labels', '--no-dock-labels'],
        'at most one of --dock-labels and --no-dock-labels',
      ],
      [['theme', 'set', '--accent', 'orange'], '--accent must be one of'],
      [['theme', 'set', '--accent'], '--accent needs a value'],
      [['theme', 'set', '--accent', '--json'], '--accent needs a value'],
      [['theme', 'set', '--colour', 'teal'], '--colour is not a flag'],
      [['theme', 'get', '--json=yes'], '--json does not take a value'],
    ] as const)
      expect(rejected(...args).message).toContain(message);
  });
});
