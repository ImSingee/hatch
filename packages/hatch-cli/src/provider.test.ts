import { describe, expect, it } from 'vitest';
import { parseProviderCommand } from './provider';

const command = (...args: string[]) => parseProviderCommand(args, 0).command;
const failure = (...args: string[]) => {
  try {
    parseProviderCommand(args, 0);
  } catch (error) {
    return error as { code?: string; message: string };
  }
  return { code: 'accepted', message: '' };
};

describe('provider command arguments', () => {
  it('pages provider and remote model lists', () => {
    expect(command('provider', 'list')).toEqual({
      kind: 'list',
      page: { limit: 0, cursor: undefined },
    });
    expect(
      command(
        'provider',
        'fetch-models',
        'p1',
        '--limit',
        '20',
        '--cursor',
        '40',
      ),
    ).toEqual({
      kind: 'fetch-models',
      id: 'p1',
      page: { limit: 20, cursor: '40' },
    });
    expect(
      command('provider', 'catalog', '--search', 'open', '--limit', '5'),
    ).toEqual({
      kind: 'catalog',
      search: 'open',
      page: { limit: 5, cursor: undefined },
    });
    expect(failure('provider', 'catalog', '--cursor', 'next').code).toBe(
      'invalid_arguments',
    );
    expect(failure('provider', 'list', '--limit', '0').code).toBe(
      'invalid_arguments',
    );
    expect(
      failure('provider', 'fetch-models', 'p1', '--cursor', 'x').code,
    ).toBe('invalid_arguments');
  });

  it('orders providers', () => {
    expect(command('provider', 'reorder', 'p2', 'p1')).toEqual({
      kind: 'reorder',
      providerIds: ['p2', 'p1'],
    });
    expect(failure('provider', 'reorder').code).toBe('invalid_arguments');
    expect(failure('provider', 'reorder', 'p1', 'p1').code).toBe(
      'invalid_arguments',
    );
  });

  it('maps add from a catalog preset or from explicit fields', () => {
    expect(
      command('provider', 'add', '--catalog', 'openai', '--api-key-file', '-'),
    ).toEqual({
      kind: 'add',
      catalogProviderId: 'openai',
      apiKeyFile: '-',
      modelIds: [],
      imageModelIds: [],
      noModels: false,
    });
    expect(
      command(
        'provider',
        'add',
        '--name',
        'Local',
        '--api-type',
        'openai-completions',
        '--base-url',
        'http://localhost:11434/v1',
        '--api-key-file',
        'key.txt',
        '--model',
        'llama3:8b',
        '--model',
        'org/model',
        '--image-model',
        'org/model',
      ),
    ).toEqual({
      kind: 'add',
      name: 'Local',
      apiType: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyFile: 'key.txt',
      modelIds: ['llama3:8b', 'org/model'],
      imageModelIds: ['org/model'],
      noModels: false,
    });
    expect(
      command(
        'provider',
        'add',
        '--catalog',
        'anthropic',
        '--name',
        'Work',
        '--api-key-file',
        '-',
        '--no-models',
      ),
    ).toMatchObject({ name: 'Work', modelIds: [], noModels: true });
  });

  it('leaves omitted update fields out and maps explicit clears', () => {
    expect(command('provider', 'update', 'p1', '--disable')).toEqual({
      kind: 'update',
      id: 'p1',
      enabled: false,
    });
    expect(
      command(
        'provider',
        'update',
        'p1',
        '--api-key-file',
        '-',
        '--clear-catalog',
      ),
    ).toEqual({
      kind: 'update',
      id: 'p1',
      apiKeyFile: '-',
      clearCatalogProvider: true,
    });
    expect(command('provider', 'remove', 'p1', '--yes')).toEqual({
      kind: 'remove',
      id: 'p1',
    });
    expect(command('provider', 'test', 'p1', '--model', 'a:b/c')).toEqual({
      kind: 'test',
      id: 'p1',
      modelId: 'a:b/c',
    });
  });

  it('never accepts an API key as an argument value', () => {
    for (const args of [
      ['provider', 'add', '--catalog', 'openai', '--api-key', 'sk-secret'],
      ['provider', 'add', '--catalog', 'openai', '--api-key=sk-secret'],
      ['provider', 'update', 'p1', '--api-key', 'sk-secret'],
    ]) {
      const error = failure(...args);
      expect(error.code).toBe('invalid_arguments');
      expect(error.message).not.toContain('sk-secret');
      expect(error.message).toContain('--api-key-file');
    }
    // The key itself is required, from a file or stdin.
    expect(failure('provider', 'add', '--catalog', 'openai').message).toMatch(
      /--api-key-file/,
    );
  });

  it('rejects contradictory, incomplete or unusable input before any request', () => {
    const cases: string[][] = [
      ['provider', 'add', '--name', 'X', '--api-key-file', '-'],
      [
        'provider',
        'add',
        '--catalog',
        'openai',
        '--api-key-file',
        '-',
        '--model',
        'gpt',
        '--no-models',
      ],
      [
        'provider',
        'add',
        '--catalog',
        'openai',
        '--api-key-file',
        '-',
        '--model',
        'gpt',
        '--model',
        'gpt',
      ],
      [
        'provider',
        'add',
        '--catalog',
        'openai',
        '--api-key-file',
        '-',
        '--image-model',
        'gpt-image',
        '--no-models',
      ],
      [
        'provider',
        'add',
        '--catalog',
        'openai',
        '--api-key-file',
        '-',
        '--api-type',
        'grpc',
      ],
      [
        'provider',
        'add',
        '--catalog',
        'openai',
        '--api-key-file',
        '-',
        '--base-url',
        'ftp://x',
      ],
      ['provider', 'update', 'p1'],
      ['provider', 'update', 'p1', '--enable', '--disable'],
      ['provider', 'update', 'p1', '--catalog', 'x', '--clear-catalog'],
      ['provider', 'update', '--name', 'X'],
      ['provider', 'remove', 'p1'],
      ['provider', 'test'],
      ['provider', 'get', 'p1', 'p2'],
      ['provider', 'list', 'extra'],
      ['provider', 'rename', 'p1'],
    ];
    expect(
      cases.filter((args) => failure(...args).code !== 'invalid_arguments'),
    ).toEqual([]);
  });
});
