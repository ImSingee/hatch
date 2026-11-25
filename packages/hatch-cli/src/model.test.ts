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
      ['model', 'list', '--enabled', '--disabled'],
      ['model', 'add', '--provider', 'p1'],
      ['model', 'add', '--model-id', 'x'],
      ['model', 'add', '--provider', 'p1', '--model-id', 'a b'],
      [
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'x',
        '--catalog-ref',
        'a/x',
        '--no-catalog',
      ],
      [
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'x',
        '--catalog-ref',
        'x',
      ],
      [
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'x',
        '--kind',
        'image',
        '--context-window',
        '1000',
      ],
      [
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'x',
        '--max-tokens',
        '0',
      ],
      [
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'x',
        '--context-window',
        '4294967296',
      ],
      [
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'x',
        '--reasoning',
        '--no-reasoning',
      ],
      ['model', 'update', 'm1'],
      ['model', 'update', 'm1', '--description', 'x', '--clear-description'],
      ['model', 'update', 'm1', '--reset', 'temperature'],
      ['model', 'update', 'm1', '--reset', 'reasoning,reasoning'],
      ['model', 'update', 'm1', '--reset', 'reasoning', '--reset-all'],
      ['model', 'update', 'm1', '--reset', 'max-tokens', '--max-tokens', '5'],
      ['model', 'update', 'm1', '--reset-all', '--no-reasoning'],
      ['model', 'update', 'm1', '--enable', '--disable'],
      ['model', 'enable'],
      ['model', 'remove', 'm1'],
      ['model', 'catalog'],
      ['model', 'catalog', 'list', '--limit', '201'],
      ['model', 'catalog', 'list', '--cursor', 'next'],
      ['model', 'catalog', 'settings'],
      ['model', 'catalog', 'settings', '--auto-update', '--no-auto-update'],
      [
        'model',
        'catalog',
        'settings',
        '--source-url',
        'http://mirror/models.json',
      ],
      [
        'model',
        'catalog',
        'settings',
        '--source-url',
        'https://mirror/models.json',
        '--clear-source-url',
      ],
    ];
    expect(
      cases.filter((args) => rejected(...args) !== 'invalid_arguments'),
    ).toEqual([]);
  });

  it('maps model changes to explicit update fields', () => {
    expect(
      command(
        'model',
        'add',
        '--provider',
        'p1',
        '--model-id',
        'meta/llama:free',
        '--catalog-ref',
        'openrouter/meta/llama:free',
        '--context-window',
        '131072',
        '--no-reasoning',
      ),
    ).toEqual({
      kind: 'add',
      providerId: 'p1',
      modelId: 'meta/llama:free',
      catalogRef: 'openrouter/meta/llama:free',
      contextWindow: 131072,
      reasoning: false,
    });
    // --reset takes CLI names and sends the proto field names.
    expect(
      command(
        'model',
        'update',
        'm1',
        '--reset',
        'context-window,max-tokens',
        '--reset',
        'reasoning',
      ),
    ).toEqual({
      kind: 'update',
      id: 'm1',
      resetFields: ['context_window', 'max_tokens', 'reasoning'],
    });
    expect(
      command('model', 'update', 'm1', '--reset-all', '--clear-description'),
    ).toEqual({
      kind: 'update',
      id: 'm1',
      description: '',
      resetFields: ['reasoning', 'context_window', 'max_tokens'],
    });
    expect(
      command(
        'model',
        'update',
        'm1',
        '--reset',
        'reasoning',
        '--max-tokens',
        '8192',
        '--no-catalog',
      ),
    ).toEqual({
      kind: 'update',
      id: 'm1',
      maxTokens: 8192,
      noCatalog: true,
      resetFields: ['reasoning'],
    });
    expect(command('model', 'disable', 'm1')).toEqual({
      kind: 'update',
      id: 'm1',
      enabled: false,
    });
    expect(command('model', 'remove', 'm1', '--yes')).toEqual({
      kind: 'remove',
      id: 'm1',
    });
    expect(
      command(
        'model',
        'list',
        '--provider',
        'p1',
        '--disabled',
        '--kind',
        'chat',
      ),
    ).toEqual({
      kind: 'list',
      modelKind: 'chat',
      providerId: 'p1',
      enabled: false,
      page: { limit: 0, cursor: undefined },
    });
  });

  it('maps catalog commands', () => {
    expect(
      command(
        'model',
        'catalog',
        'list',
        '--provider',
        'openai',
        '--search',
        'gpt mini',
        '--limit',
        '200',
        '--cursor',
        '200',
      ),
    ).toEqual({
      kind: 'catalog-list',
      providerId: 'openai',
      query: 'gpt mini',
      limit: 200,
      cursor: '200',
    });
    expect(command('model', 'catalog', 'list')).toEqual({
      kind: 'catalog-list',
      limit: 0,
    });
    expect(
      command(
        'model',
        'catalog',
        'settings',
        '--no-auto-update',
        '--clear-source-url',
      ),
    ).toEqual({
      kind: 'catalog-settings',
      autoUpdate: false,
      clearSourceUrl: true,
    });
  });
});
