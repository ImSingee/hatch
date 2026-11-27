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
    expect(
      parse('usage', 'writer', '--limit', '10', '--cursor', '01abc'),
    ).toMatchObject({ limit: 10, cursor: '01abc' });
  });

  it('distinguishes unchanged, set and cleared defaults', () => {
    expect(parse('defaults')).toMatchObject({
      action: 'defaults',
      id: undefined,
      chatModel: undefined,
      imageModel: undefined,
    });
    expect(
      parse('defaults', '--chat-model', 'Alpha/a-1', '--clear-image-model'),
    ).toMatchObject({ chatModel: 'Alpha/a-1', imageModel: null });
    expect(parse('defaults', '--image-model', 'img-1')).toMatchObject({
      chatModel: undefined,
      imageModel: 'img-1',
    });
  });

  it('rejects contradictory, missing and misplaced input locally', () => {
    const cases: [RegExp, string[]][] = [
      [/Use hatch app ai/, ['budget', 'writer']],
      [/exactly one App/, ['show']],
      [/takes no App/, ['defaults', 'writer']],
      [/--role/, ['set-model', 'writer', '--model', 'a']],
      [/--model .* or --clear/, ['set-model', 'writer', '--role', 'r']],
      [
        /either --model or --clear/,
        ['set-model', 'writer', '--role', 'r', '--model', 'a', '--clear'],
      ],
      [
        /either --chat-model or --clear-chat-model/,
        ['defaults', '--chat-model', 'a', '--clear-chat-model'],
      ],
      [/--image-model must be/, ['defaults', '--image-model', ' ']],
      [
        /applies only to app ai defaults/,
        ['show', 'writer', '--chat-model', 'a'],
      ],
      [/applies only to app ai set-model/, ['defaults', '--role', 'r']],
      [/applies only to app ai usage/, ['show', 'writer', '--limit', '5']],
      [/--limit must be/, ['usage', 'writer', '--limit', '0']],
    ];
    for (const [pattern, args] of cases)
      expect(() => parse(...args)).toThrow(pattern);
  });
});
