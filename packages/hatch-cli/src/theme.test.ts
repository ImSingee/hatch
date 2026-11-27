import { describe, expect, it } from 'vitest';
import tokens from '../../hatch-design-tokens/tokens.json';
import { accentOverrideNote, parseThemeCommand } from './theme';

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
    expect(command('theme', 'get')).toEqual({ kind: 'get', resolve: false });
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
      [['theme', 'set'], 'Supply --theme, --accent, --clear-accent'],
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

describe('the theme library commands', () => {
  it('maps get --resolved, activation, listing and every library change', () => {
    expect(command('theme', 'get', '--resolved')).toEqual({
      kind: 'get',
      resolve: true,
    });
    expect(command('theme', 'set', '--theme', 'desk-dark')).toEqual({
      kind: 'set',
      theme: 'desk-dark',
    });
    expect(
      command(
        'theme',
        'set',
        '--theme',
        '01m8c9a96grbxmn2t7n5c7f0s0',
        '--clear-accent',
        '--dock-labels',
      ),
    ).toEqual({
      kind: 'set',
      theme: '01m8c9a96grbxmn2t7n5c7f0s0',
      clearAccent: true,
      dockLabels: true,
    });
    expect(command('theme', 'list')).toEqual({
      kind: 'list',
      page: { limit: 0 },
    });
    expect(command('theme', 'list', '--limit', '5', '--cursor', '5')).toEqual({
      kind: 'list',
      page: { limit: 5, cursor: '5' },
    });
    expect(command('theme', 'create', '--file', 'meadow.json')).toEqual({
      kind: 'create',
      file: 'meadow.json',
    });
    expect(command('theme', 'update', 'abc123', '--file', '-')).toEqual({
      kind: 'update',
      id: 'abc123',
      file: '-',
    });
    expect(command('theme', 'delete', 'abc123', '--yes')).toEqual({
      kind: 'delete',
      id: 'abc123',
    });
    expect(command('theme', 'check', '--file', 'meadow.json')).toEqual({
      kind: 'check',
      file: 'meadow.json',
    });
    expect(command('theme', 'reset')).toEqual({ kind: 'reset' });
  });

  it('rejects incomplete or malformed input before any request and names the flag', () => {
    for (const [args, message] of [
      [['theme', 'set', '--theme', 'Not An Id'], '--theme must be a theme id'],
      [['theme', 'set', '--theme', ''], '--theme must not be empty'],
      [['theme', 'set', '--mode', 'dark'], '--mode is not a flag'],
      [['theme', 'create'], 'Supply --file'],
      [['theme', 'create', 'abc'], 'no positional arguments'],
      [['theme', 'update', '--file', 'a.json'], 'Supply exactly one theme id'],
      [['theme', 'update', 'abc123'], 'Supply --file'],
      [
        ['theme', 'update', 'a', 'b', '--file', '-'],
        'Supply exactly one theme id',
      ],
      [['theme', 'delete', '--yes'], 'Supply exactly one theme id'],
      [
        ['theme', 'delete', 'UPPER', '--yes'],
        'The theme id must be a theme id',
      ],
      [
        ['theme', 'delete', 'abc', '--yes', '--file', 'x'],
        '--file is not a flag',
      ],
      [['theme', 'delete', 'abc'], 'cannot be undone; pass --yes'],
      [['theme', 'list', '--limit', '0'], '--limit must be a whole number'],
      [['theme', 'check'], 'Supply --file'],
      [['theme', 'presets'], 'Use hatch theme get, set, list'],
      [['theme', 'reset', '--theme', 'desk'], '--theme is not a flag'],
      [
        ['theme', 'set', '--accent', 'teal', '--clear-accent'],
        'at most one of --accent and --clear-accent',
      ],
    ] as const)
      expect({
        args,
        code: rejected(...args).code,
        message: rejected(...args).message,
      }).toMatchObject({
        args,
        code: 'invalid_arguments',
        message: expect.stringContaining(message),
      });
  });
});

describe('theme set after activating a theme', () => {
  const state = (accent: string | null, accentOverridesPrimary: boolean) => ({
    accent,
    accentOverridesPrimary,
    theme: { name: 'Meadow', primary: '#2F6B3A' },
  });

  it('notes an accent that hides the theme primary and names the fix', () => {
    expect(accentOverrideNote(state('teal', true))).toBe(
      'Note: the teal accent replaces the primary #2F6B3A of the theme "Meadow". Run hatch theme set --clear-accent to show it.',
    );
  });

  it('says nothing when the theme shows its own primary', () => {
    expect(accentOverrideNote(state(null, false))).toBeNull();
    expect(accentOverrideNote(state('indigo', false))).toBeNull();
  });
});
