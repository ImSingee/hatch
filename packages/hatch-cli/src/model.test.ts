import { describe, expect, it } from 'vitest';
import { parseModelCommand } from './model';

const command = (...args: string[]) => parseModelCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parseModelCommand(args, 0);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};

describe('model command arguments', () => {
  it('maps each command to one explicit operation', () => {
    expect(command('model', 'list')).toEqual({
      kind: 'list',
      page: { limit: 0, cursor: undefined },
    });
    expect(command('model', 'list', '--kind', 'image', '--limit', '5')).toEqual(
      {
        kind: 'list',
        modelKind: 'image',
        page: { limit: 5, cursor: undefined },
      },
    );
    expect(command('model', 'set-kind', 'm1', '--kind', 'chat')).toEqual({
      kind: 'set-kind',
      id: 'm1',
      modelKind: 'chat',
    });
  });

  it('rejects ambiguous or unusable input before any request', () => {
    const cases: string[][] = [
      ['model', 'list', 'extra'],
      ['model', 'list', '--kind', 'video'],
      ['model', 'list', '--limit', '0'],
      ['model', 'set-kind', 'm1'],
      ['model', 'set-kind', '--kind', 'image'],
      ['model', 'set-kind', 'm1', 'm2', '--kind', 'image'],
      ['model', 'set-kind', 'm1', '--kind', ''],
      ['model', 'rename', 'm1'],
    ];
    expect(
      cases.filter((args) => rejected(...args) !== 'invalid_arguments'),
    ).toEqual([]);
  });
});
