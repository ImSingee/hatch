import { describe, expect, it } from 'vitest';
import {
  QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH,
  queryAppDataTableRequestSchema,
  queryAppKvRequestSchema,
} from './data-schemas';

describe('query app KV requests', () => {
  it('parses every action and defaults list pagination', () => {
    expect(queryAppKvRequestSchema.parse({ action: 'list' })).toEqual({
      action: 'list',
      limit: 100,
      revealSecrets: false,
    });
    expect(
      queryAppKvRequestSchema.parse({
        action: 'list',
        cursor: 'last-key',
        limit: 25,
      }),
    ).toEqual({
      action: 'list',
      cursor: 'last-key',
      limit: 25,
      revealSecrets: false,
    });
    expect(
      queryAppKvRequestSchema.parse({ action: 'get', key: 'token' }),
    ).toEqual({ action: 'get', key: 'token', revealSecrets: false });
    expect(
      queryAppKvRequestSchema.parse({
        action: 'set',
        key: 'token',
        value: 'value',
        secret: true,
      }),
    ).toEqual({
      action: 'set',
      key: 'token',
      value: 'value',
      secret: true,
    });
    expect(
      queryAppKvRequestSchema.safeParse({ action: 'delete', key: 'token' })
        .success,
    ).toBe(true);
  });

  it('allows explicit secret reveal only for read actions', () => {
    for (const input of [
      { action: 'list', revealSecrets: true },
      { action: 'get', key: 'token', revealSecrets: true },
    ]) {
      expect(queryAppKvRequestSchema.parse(input)).toMatchObject({
        revealSecrets: true,
      });
    }
    expect(
      queryAppKvRequestSchema.safeParse({
        action: 'set',
        key: 'token',
        value: 'value',
        revealSecrets: true,
      }).success,
    ).toBe(false);
    expect(
      queryAppKvRequestSchema.safeParse({
        action: 'delete',
        key: 'token',
        revealSecrets: true,
      }).success,
    ).toBe(false);
  });

  it('rejects missing, invalid, and action-inappropriate fields', () => {
    for (const input of [
      { action: 'get' },
      { action: 'set', key: 'token' },
      { action: 'delete', key: 'token', value: 'extra' },
      { action: 'list', key: 'extra' },
      { action: 'list', cursor: 'x'.repeat(513) },
      { action: 'list', cursor: null },
      { action: 'list', cursor: 123 },
      { action: 'get', key: 'token', cursor: '' },
      { action: 'set', key: 'token', value: '', cursor: '' },
      { action: 'delete', key: 'token', cursor: '' },
      { action: 'list', limit: 0 },
      { action: 'list', limit: 101 },
      { action: 'list', limit: 1.5 },
      { action: 'unknown' },
    ]) {
      expect(queryAppKvRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it('accepts cursor length boundaries unchanged for list continuations', () => {
    for (const cursor of ['a', 'x'.repeat(512)]) {
      expect(queryAppKvRequestSchema.parse({ action: 'list', cursor })).toEqual(
        {
          action: 'list',
          cursor,
          limit: 100,
          revealSecrets: false,
        },
      );
    }
  });

  it('normalizes an empty list cursor to first-page omission without changing the request', () => {
    const input = { action: 'list', cursor: '' };
    expect(queryAppKvRequestSchema.parse(input)).toEqual(
      queryAppKvRequestSchema.parse({ action: 'list' }),
    );
    expect(input).toEqual({ action: 'list', cursor: '' });
  });
});

describe('query app Data Table requests', () => {
  it('normalizes empty inspect tables and query cursors to omission', () => {
    const inspect = { action: 'inspect', table: '' };
    const query = { action: 'query', table: 'todos', cursor: '' };
    expect(queryAppDataTableRequestSchema.parse(inspect)).toEqual({
      action: 'inspect',
    });
    expect(queryAppDataTableRequestSchema.parse(query)).toEqual(
      queryAppDataTableRequestSchema.parse({ action: 'query', table: 'todos' }),
    );
    expect(inspect.table).toBe('');
    expect(query.cursor).toBe('');
  });
  it('parses inspect and defaults structured query fields', () => {
    expect(queryAppDataTableRequestSchema.parse({ action: 'inspect' })).toEqual(
      { action: 'inspect' },
    );
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'inspect',
        table: 'todos',
      }),
    ).toEqual({ action: 'inspect', table: 'todos' });
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'query',
        table: 'todos',
      }),
    ).toEqual({
      action: 'query',
      table: 'todos',
      where: [],
      limit: 50,
    });
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'query',
        table: 'todos',
        where: [{ field: 'done', op: 'eq', value: false }],
        orderBy: { field: 'createdAt' },
        cursor: 'next-page',
        limit: 200,
      }),
    ).toEqual({
      action: 'query',
      table: 'todos',
      where: [{ field: 'done', op: 'eq', value: false }],
      orderBy: { field: 'createdAt', direction: 'asc' },
      cursor: 'next-page',
      limit: 200,
    });
  });

  it('parses every mutation and defaults patch unset', () => {
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'mutate',
        operations: [
          { type: 'insert', table: 'todos', value: { title: 'Ship' } },
          {
            type: 'patch',
            table: 'todos',
            id: 'todo-1',
            value: { done: true },
          },
          {
            type: 'increment',
            table: 'stats',
            id: 'stats-1',
            field: 'count',
            amount: 1,
          },
          { type: 'delete', table: 'todos', id: 'todo-2' },
        ],
      }),
    ).toEqual({
      action: 'mutate',
      operations: [
        { type: 'insert', table: 'todos', value: { title: 'Ship' } },
        {
          type: 'patch',
          table: 'todos',
          id: 'todo-1',
          value: { done: true },
          unset: [],
        },
        {
          type: 'increment',
          table: 'stats',
          id: 'stats-1',
          field: 'count',
          amount: 1,
        },
        { type: 'delete', table: 'todos', id: 'todo-2' },
      ],
    });
  });

  it('defaults and bounds raw SQL timeout without limiting statements', () => {
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'raw_sql',
        sql: 'select 1; select 2',
      }),
    ).toEqual({
      action: 'raw_sql',
      sql: 'select 1; select 2',
      timeoutMs: 30_000,
    });
    expect(
      queryAppDataTableRequestSchema.parse({
        action: 'raw_sql',
        sql: 'select pg_sleep(1)',
        timeoutMs: 1_800_000,
      }),
    ).toMatchObject({ timeoutMs: 1_800_000 });
  });

  it('rejects invalid bounds and action-inappropriate or nested fields', () => {
    const tooManyFilters = Array.from({ length: 17 }, () => ({
      field: 'done',
      op: 'eq',
      value: false,
    }));
    for (const input of [
      { action: 'inspect', limit: 1 },
      { action: 'query' },
      { action: 'query', table: 'todos', limit: 0 },
      { action: 'query', table: 'todos', limit: 201 },
      { action: 'query', table: 'todos', where: tooManyFilters },
      {
        action: 'query',
        table: 'todos',
        cursor: 'x'.repeat(QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH + 1),
      },
      {
        action: 'query',
        table: 'todos',
        orderBy: { field: 'createdAt', extra: true },
      },
      { action: 'mutate', operations: [] },
      {
        action: 'mutate',
        operations: [
          { type: 'delete', table: 'todos', id: 'todo-1', extra: true },
        ],
      },
      { action: 'raw_sql', sql: '   ' },
      { action: 'raw_sql', sql: 'select 1', timeoutMs: 999 },
      { action: 'raw_sql', sql: 'select 1', timeoutMs: 1_800_001 },
      { action: 'raw_sql', sql: 'select 1', timeoutMs: 1_000.5 },
      { action: 'raw_sql', sql: 'select 1', table: 'todos' },
      { action: 'unknown' },
    ]) {
      expect(queryAppDataTableRequestSchema.safeParse(input).success).toBe(
        false,
      );
    }
  });
});
