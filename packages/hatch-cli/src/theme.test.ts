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
    ])
      expect({ args, code: rejected(...args).code }).toEqual({
        args,
        code: 'invalid_arguments',
      });
    expect(rejected('theme', 'set', '--accent', 'orange').message).toContain(
      '--accent must be one of',
    );
  });
});
