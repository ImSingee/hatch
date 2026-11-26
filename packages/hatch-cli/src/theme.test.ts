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
    expect(command('theme', 'get')).toEqual({ kind: 'get', resolve: [] });
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
      [['theme', 'set'], 'Supply --accent, --clear-accent, --dock-labels'],
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

describe('theme modes, presets and custom themes', () => {
  it('maps get --resolved to the mode or to one appearance', () => {
    expect(command('theme', 'get', '--resolved')).toEqual({
      kind: 'get',
      resolve: 'mode',
    });
    expect(
      command('theme', 'get', '--resolved', '--appearance', 'dark'),
    ).toEqual({ kind: 'get', resolve: ['dark'] });
  });

  it('maps set, leaving out every field that is not given', () => {
    expect(command('theme', 'set', '--mode', 'system')).toEqual({
      kind: 'set',
      mode: 'system',
    });
    expect(command('theme', 'set', '--clear-accent')).toEqual({
      kind: 'set',
      clearAccent: true,
    });
    expect(
      command(
        'theme',
        'set',
        '--mode',
        'dark',
        '--appearance',
        'dark',
        '--preset',
        'desk-dark',
      ),
    ).toEqual({
      kind: 'set',
      mode: 'dark',
      appearance: 'dark',
      preset: 'desk-dark',
    });
    expect(
      command('theme', 'set', '--appearance', 'light', '--file', '-'),
    ).toEqual({ kind: 'set', appearance: 'light', file: '-' });
    expect(
      command(
        'theme',
        'set',
        '--accent',
        'clay',
        '--appearance',
        'light',
        '--file',
        'meadow.json',
        '--dock-labels',
      ),
    ).toEqual({
      kind: 'set',
      accent: 'clay',
      dockLabels: true,
      appearance: 'light',
      file: 'meadow.json',
    });
    expect(command('theme', 'check', '--file', 'meadow.json')).toEqual({
      kind: 'check',
      file: 'meadow.json',
    });
    expect(command('theme', 'presets')).toEqual({ kind: 'presets' });
    expect(command('theme', 'reset')).toEqual({ kind: 'reset' });
  });

  it('rejects contradictory or incomplete input before any request and names the flag', () => {
    for (const [args, message] of [
      [['theme', 'set', '--preset', 'desk'], '--preset needs --appearance'],
      [['theme', 'set', '--file', 'a.json'], '--file needs --appearance'],
      [
        ['theme', 'set', '--appearance', 'light'],
        '--appearance needs --preset',
      ],
      [
        [
          'theme',
          'set',
          '--appearance',
          'light',
          '--preset',
          'desk',
          '--file',
          '-',
        ],
        'at most one of --preset and --file',
      ],
      [
        ['theme', 'set', '--accent', 'teal', '--clear-accent'],
        'at most one of --accent and --clear-accent',
      ],
      [
        ['theme', 'set', '--mode', 'dim'],
        '--mode must be light, dark or system',
      ],
      [['theme', 'set', '--mode', ''], '--mode must not be empty'],
      [
        ['theme', 'set', '--appearance', 'sepia', '--preset', 'desk'],
        '--appearance must be light or dark',
      ],
      [
        ['theme', 'set', '--appearance', 'light', '--preset', 'ocean'],
        '--preset must be one of: desk, desk-dark',
      ],
      [
        ['theme', 'set', '--appearance', 'light', '--file', ''],
        '--file must not be empty',
      ],
      [
        ['theme', 'get', '--appearance', 'dark'],
        '--appearance needs --resolved',
      ],
      [['theme', 'check'], 'Supply --file'],
      [['theme', 'check', '--preset', 'desk'], '--preset is not a flag'],
      [['theme', 'presets', 'desk'], 'no positional arguments'],
      [['theme', 'reset', '--mode', 'light'], '--mode is not a flag'],
      [
        ['theme', 'set', '--clear-accent=yes'],
        '--clear-accent does not take a value',
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

describe('theme set after a new theme', () => {
  const state = (accent: string | null, accentOverrides: string[]) => ({
    accent,
    accentOverrides,
    light: { name: 'Meadow', primary: '#2F6B3A' },
    dark: { name: 'Desk dark', primary: '#3F51C7' },
  });

  it('notes an accent that hides the theme primary and names the fix', () => {
    expect(accentOverrideNote(state('teal', ['light', 'dark']), 'light')).toBe(
      'Note: the teal accent replaces the primary #2F6B3A of the light theme "Meadow". Run hatch theme set --clear-accent to show it.',
    );
  });

  it('says nothing when the theme shows its own primary', () => {
    expect(accentOverrideNote(state(null, []), 'light')).toBeNull();
    expect(accentOverrideNote(state('indigo', ['light']), 'dark')).toBeNull();
  });
});
