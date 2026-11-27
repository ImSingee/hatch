import { describe, expect, it } from 'vitest';
import { parseAiCommand } from './ai';

const parse = (...args: string[]) => parseAiCommand(['app', 'ai', ...args], 0);
describe('hatch app ai arguments', () => {
  it('maps each action to its request fields', () => {
    expect(parse('show', 'writer', '--json')).toMatchObject({
      action: 'show',
      id: 'writer',
      json: true,
    });
    expect(
      parse(
        'set-model',
        'writer',
        '--role',
        'summarize',
        '--model',
        'Alpha/a-1',
      ),
    ).toMatchObject({ role: 'summarize', model: 'Alpha/a-1' });
    expect(
      parse('set-model', 'writer', '--role', 'summarize', '--clear'),
    ).toMatchObject({ role: 'summarize', model: null });
    expect(parse('budget', 'writer', '--monthly-usd', '12.5')).toMatchObject({
      budgetUsd: 12.5,
    });
    expect(parse('budget', 'writer', '--monthly-usd', '0')).toMatchObject({
      budgetUsd: 0,
    });
    expect(parse('budget', 'writer', '--clear')).toMatchObject({
      budgetUsd: null,
    });
    expect(
      parse('usage', 'writer', '--limit', '10', '--cursor', '01abc'),
    ).toMatchObject({ limit: 10, cursor: '01abc' });
  });

  it('rejects contradictory, missing and misplaced input locally', () => {
    const cases: [RegExp, string[]][] = [
      [/Use hatch app ai/, ['list', 'writer']],
      [/exactly one App/, ['show']],
      [/--role/, ['set-model', 'writer', '--model', 'a']],
      [/--model .* or --clear/, ['set-model', 'writer', '--role', 'r']],
      [
        /either --model or --clear/,
        ['set-model', 'writer', '--role', 'r', '--model', 'a', '--clear'],
      ],
      [/--monthly-usd <amount> or --clear/, ['budget', 'writer']],
      [
        /either --monthly-usd or --clear/,
        ['budget', 'writer', '--monthly-usd', '1', '--clear'],
      ],
      [/--monthly-usd must be/, ['budget', 'writer', '--monthly-usd=-1']],
      [/--monthly-usd must be/, ['budget', 'writer', '--monthly-usd', '1e3']],
      [/applies only to app ai set-model/, ['show', 'writer', '--role', 'r']],
      [/applies only to app ai usage/, ['show', 'writer', '--limit', '5']],
      [/--limit must be/, ['usage', 'writer', '--limit', '0']],
    ];
    for (const [pattern, args] of cases)
      expect(() => parse(...args)).toThrow(pattern);
  });
});
