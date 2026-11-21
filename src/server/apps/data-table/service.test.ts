import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSchemaDescriptor } from './schema';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options?: unknown) => Promise<unknown>>(),
  postgres: vi.fn<(url?: unknown, options?: unknown) => unknown>(),
  resolveDataUrl: vi.fn<() => Promise<string>>(),
}));

vi.mock('~/db', () => ({
  db: {
    query: {
      apps: { findFirst: mocks.findApp },
      deployments: { findFirst: mocks.findDeployment },
    },
  },
}));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('./provision', () => ({
  resolveAppDataDatabaseUrl: mocks.resolveDataUrl,
}));

import {
  assertDataTableAccess,
  executeDataTableRawSql,
  inspectDataTables,
  mutateDataTable,
  queryDataTable,
} from './service';

const APP_ID = '01j00000000000000000000000';
const DEPLOYMENT_ID = '01j00000000000000000000001';
const NOW = new Date('2026-07-13T00:00:00.000Z');

type UnsafeHandler = (
  statement: string,
  params: readonly unknown[] | undefined,
) => Promise<Record<string, unknown>[]>;
type TaggedHandler = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;
type BeginHandler = (...args: unknown[]) => Promise<unknown>;
type EndHandler = () => Promise<void>;
type RawQueryResult = {
  command: string | null;
  count: number | null;
  rows: Record<string, unknown>[];
};
type RawQueryHandler = (
  statement: string,
  signal: AbortSignal | undefined,
) => Promise<RawQueryResult | RawQueryResult[]>;

function rawResult(
  rows: Record<string, unknown>[],
  command: string,
  count: number | null,
): RawQueryResult {
  return { command, count, rows };
}

/** postgres.js rejects a query stopped by its CancelRequest with 57014. */
function canceledStatement(): Error {
  return Object.assign(new Error('canceling statement due to user request'), {
    code: '57014',
  });
}

/**
 * Mock postgres.js client for raw SQL: a pool whose reserved connection runs
 * tagged and simple-protocol queries, streams rows to `forEach` with each
 * statement's own result object, and honors `.signal()` as a cancellation.
 */
function createRawHarness(
  options: {
    events?: string[];
    query?: RawQueryHandler;
    commit?: () => Promise<RawQueryResult>;
    reserve?: () => Promise<void>;
    /** PostgreSQL never acts on the CancelRequest. */
    ignoreCancel?: boolean;
  } = {},
) {
  const events = options.events ?? [];
  const canceled: string[] = [];
  const run = (
    statement: string,
    execute: (signal: AbortSignal | undefined) => Promise<unknown>,
  ) => {
    let signal: AbortSignal | undefined;
    let onRow: ((row: unknown, result: unknown) => void) | undefined;
    // Like postgres.js, nothing is sent until the synchronous modifier chain
    // (`.simple().signal(...).forEach(...)`) has been applied.
    const promise = Promise.resolve().then(async () => {
      events.push(statement);
      if (signal?.aborted) throw canceledStatement();
      let onAbort = () => {};
      const abort = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          canceled.push(statement);
          if (!options.ignoreCancel) reject(canceledStatement());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      const raw = await Promise.race([execute(signal), abort]).finally(() =>
        signal?.removeEventListener('abort', onAbort),
      );
      if (!onRow) return raw;
      const results = (Array.isArray(raw) ? raw : [raw]).map(
        (result: RawQueryResult) => {
          const meta = Object.assign([], {
            command: result.command,
            count: result.count,
          });
          for (const row of result.rows) onRow?.(row, meta);
          return meta;
        },
      );
      return Array.isArray(raw) ? results : results[0];
    });
    const pending = Object.assign(promise, {
      simple: () => pending,
      signal: (value: AbortSignal) => {
        signal = value;
        return pending;
      },
      forEach: (callback: (row: unknown, result: unknown) => void) => {
        onRow = callback;
        return promise;
      },
    });
    return pending;
  };
  const control = async (statement: string) => {
    const normalized = statement.trim().toLowerCase();
    if (normalized === 'commit' && options.commit) return options.commit();
    if (normalized.includes('pg_try_advisory_xact_lock_shared')) {
      return [{ ok: true }];
    }
    return [];
  };
  const tagged = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join('$1').replaceAll(/\s+/g, ' ').trim();
    return run(statement, () => control(statement));
  };
  const unsafe = (statement: string) =>
    run(statement, async (signal) => {
      if (statement.startsWith('set local')) return rawResult([], 'SET', null);
      if (!options.query) {
        throw new Error(`Unexpected raw SQL in test: ${statement}`);
      }
      return options.query(statement, signal);
    });
  const connection = Object.assign(tagged, { unsafe });
  const client = {
    reserve: vi.fn<() => Promise<typeof connection>>(async () => {
      await options.reserve?.();
      return connection;
    }),
    end: vi.fn<(options?: unknown) => Promise<void>>(async () => {}),
  };
  mocks.postgres.mockImplementationOnce(() => client);
  return { client, events, canceled };
}

function createHarness(
  schema: DataSchemaDescriptor,
  options: {
    unsafe?: UnsafeHandler;
    events?: string[];
    revision?: string | number;
  } = {},
) {
  const unsafe = vi.fn<UnsafeHandler>(
    options.unsafe ?? (async () => [] as Record<string, unknown>[]),
  );
  const tagged = vi.fn<TaggedHandler>(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim();
      if (statement.includes('pg_try_advisory_xact_lock_shared')) {
        options.events?.push('lock');
        return [{ ok: true }];
      }
      if (
        statement.includes('schema_snapshot') &&
        statement.includes('_hatch.migrations')
      ) {
        return [{ schema_snapshot: schema, schema_hash: 'schema-hash' }];
      }
      if (statement.includes('coalesce(max(seq), 0)::text as revision')) {
        return [{ revision: options.revision ?? '0' }];
      }
      if (
        statement.includes('select id, deployment_id') &&
        statement.includes('_hatch.migrations')
      ) {
        return [];
      }
      throw new Error(`Unexpected tagged SQL in test: ${statement}`);
    },
  );
  const tx = Object.assign(tagged, { unsafe });
  const client = Object.assign(tagged, {
    unsafe,
    begin: vi.fn<BeginHandler>(async (...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback !== 'function') {
        throw new TypeError('Transaction callback is missing');
      }
      const result = await callback(tx);
      options.events?.push('transaction-end');
      return result;
    }),
    end: vi.fn<EndHandler>(async () => {}),
  });
  mocks.postgres.mockReturnValue(client);
  return { client, tx, unsafe };
}

function schemaWithFields(
  fields: DataSchemaDescriptor['tables'][string]['fields'],
  indexes: DataSchemaDescriptor['tables'][string]['indexes'] = [],
): DataSchemaDescriptor {
  return {
    version: 1,
    tables: { items: { fields, indexes } },
  };
}

function liveApp(overrides: Record<string, unknown> = {}) {
  return {
    status: 'deployed',
    currentDeploymentId: DEPLOYMENT_ID,
    capabilities: { dataTable: true },
    dataActivationId: null,
    ...overrides,
  };
}

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('managed Data Table service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgres.mockReset();
    mocks.resolveDataUrl.mockResolvedValue(
      'postgres://data:data@127.0.0.1:5432/data',
    );
    vi.stubEnv(
      'APP_DATABASE_URL',
      'postgres://admin:secret@127.0.0.1:5432/platform',
    );
    vi.stubEnv('APP_URL', 'http://localhost:3700');
    vi.stubEnv('SECRET', 'test-secret');
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map([[APP_ID, Date.now()]]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    ['query', () => queryDataTable(APP_ID, { table: 'items' })],
    [
      'mutation',
      () =>
        mutateDataTable(APP_ID, {
          operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
        }),
    ],
    ['inspection', () => inspectDataTables(APP_ID)],
  ])('checks the activation fence after locking for %s', async (_name, run) => {
    const events: string[] = [];
    createHarness(schemaWithFields({}), { events });
    mocks.findApp.mockImplementation(async () => {
      events.push('platform');
      return liveApp({ dataActivationId: 'pending-deployment' });
    });

    await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(events).toEqual(['lock', 'platform']);
  });

  it.each([
    [
      'query',
      () =>
        queryDataTable(
          APP_ID,
          { table: 'items' },
          { expectedDeploymentId: 'stale-deployment' },
        ),
    ],
    [
      'mutation',
      () =>
        mutateDataTable(
          APP_ID,
          {
            operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
          },
          { expectedDeploymentId: 'stale-deployment' },
        ),
    ],
  ])('rejects a stale deployment before running a %s', async (_name, run) => {
    const { unsafe } = createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('blocks App Data access below the minimum but keeps management access', async () => {
    mocks.findApp.mockResolvedValue(liveApp());
    mocks.findDeployment.mockResolvedValue({ compatibilityVersion: 0 });

    await expect(
      assertDataTableAccess(APP_ID, {
        expectedDeploymentId: DEPLOYMENT_ID,
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(assertDataTableAccess(APP_ID, {})).resolves.toBeUndefined();
    expect(mocks.findDeployment).toHaveBeenCalledOnce();
  });

  it('queries an explicit JSON null separately from SQL NULL', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: true },
    });
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'payload', op: 'eq', value: null }],
      orderBy: { field: 'payload', direction: 'asc' },
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining(
        '("payload" is null or "payload" is not distinct from $1::text::jsonb)',
      ),
      ['null', 51],
    );
  });

  it('uses JSON equality for null in a required field', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false },
    });
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'payload', op: 'eq', value: null }],
      orderBy: { field: 'payload', direction: 'asc' },
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('"payload" = $1::text::jsonb'),
      ['null', 51],
    );
  });

  it('uses a stable sort-value and id keyset cursor', async () => {
    const schema = schemaWithFields({
      score: { kind: 'integer', optional: false },
    });
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-a',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-c',
          score: 11,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.findApp.mockResolvedValue(liveApp());

    const first = await queryDataTable(APP_ID, {
      table: 'items',
      orderBy: { field: 'score', direction: 'asc' },
      limit: 2,
    });

    expect(first.items.map((item) => item.id)).toEqual(['row-a', 'row-b']);
    expect(first.items[0]).not.toHaveProperty('__hatch_cursor_order_is_null');
    expect(decodeCursor(first.cursor!)).toEqual({
      version: 1,
      queryFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      orderField: 'score',
      direction: 'asc',
      value: 10,
      sqlNull: false,
      id: 'row-b',
    });
    expect(unsafe.mock.calls[0]?.[0]).toContain(
      'order by "score" asc, "id" asc limit $1',
    );
    expect(unsafe.mock.calls[0]?.[0]).not.toContain('offset');
    expect(unsafe.mock.calls[0]?.[1]).toEqual([3]);

    await queryDataTable(APP_ID, {
      table: 'items',
      orderBy: { field: 'score', direction: 'asc' },
      cursor: first.cursor!,
      limit: 2,
    });

    const [statement, params] = unsafe.mock.calls[1] ?? [];
    expect(statement).toContain('"score" > $1');
    expect(statement).toContain('"score" is not distinct from $1');
    expect(statement).toContain('"id" > $2');
    expect(statement).toContain('or "score" is null');
    expect(params).toEqual([10, 'row-b', 3]);
  });

  it('binds Agent output pagination to the last complete returned row', async () => {
    const schema = schemaWithFields({
      body: { kind: 'string', optional: false },
    });
    const { unsafe } = createHarness(schema);
    unsafe.mockResolvedValueOnce(
      ['row-a', 'row-b', 'row-c'].map((id) => ({
        id,
        body: id === 'row-a' ? 'a'.repeat(35_000) : 'b'.repeat(35_000),
        created_at: NOW,
        updated_at: NOW,
        __hatch_cursor_order_is_null: false,
      })),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await queryDataTable(
      APP_ID,
      { table: 'items', limit: 3 },
      { resultMaxChars: 60_000 },
    );

    expect(result.items.map((item) => item.id)).toEqual(['row-a']);
    expect(result.truncated).toBe(true);
    expect(decodeCursor(result.cursor!)).toMatchObject({ id: 'row-a' });
  });

  it('rejects a first complete record that exceeds the Agent output budget', async () => {
    const schema = schemaWithFields({
      body: { kind: 'string', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async () => [
        {
          id: 'row-a',
          body: 'a'.repeat(70_000),
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ],
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, { table: 'items' }, { resultMaxChars: 60_000 }),
    ).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining('select narrower columns'),
    });
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('includes a large sort value cursor in the Agent output budget', async () => {
    const sortValue = 'x'.repeat(35_000);
    const schema = schemaWithFields({
      sort: { kind: 'string', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async () => [
        {
          id: 'row-a',
          sort: sortValue,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          sort: `${sortValue}z`,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ],
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(
        APP_ID,
        {
          table: 'items',
          orderBy: { field: 'sort', direction: 'asc' },
          limit: 1,
        },
        { resultMaxChars: 60_000 },
      ),
    ).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining('pagination cursor'),
    });
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('does not budget an intermediate cursor when the complete page fits', async () => {
    const largeSortValue = 'x'.repeat(35_000);
    const schema = schemaWithFields({
      sort: { kind: 'string', optional: false },
    });
    createHarness(schema, {
      unsafe: async () => [
        {
          id: 'row-a',
          sort: largeSortValue,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          sort: 'z',
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ],
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await queryDataTable(
      APP_ID,
      {
        table: 'items',
        orderBy: { field: 'sort', direction: 'asc' },
        limit: 2,
      },
      { resultMaxChars: 60_000 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.cursor).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('finds the largest fitting prefix when cursor sizes are non-monotonic', async () => {
    const largeSortValue = 'x'.repeat(35_000);
    const schema = schemaWithFields({
      sort: { kind: 'string', optional: false },
    });
    createHarness(schema, {
      unsafe: async () => [
        {
          id: 'row-a',
          sort: 'a',
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          sort: largeSortValue,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-c',
          sort: 'z',
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-d',
          sort: 'zz',
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ],
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await queryDataTable(
      APP_ID,
      {
        table: 'items',
        orderBy: { field: 'sort', direction: 'asc' },
        limit: 3,
      },
      { resultMaxChars: 60_000 },
    );

    expect(result.items.map((item) => item.id)).toEqual([
      'row-a',
      'row-b',
      'row-c',
    ]);
    expect(decodeCursor(result.cursor!)).toMatchObject({ id: 'row-c' });
    expect(result.truncated).toBe(false);
  });

  it('binds a cursor to its table and filters but not its limit', async () => {
    const table = {
      fields: {
        tenant: { kind: 'string' as const, optional: false },
        score: { kind: 'integer' as const, optional: false },
      },
      indexes: [],
    } satisfies DataSchemaDescriptor['tables'][string];
    const schema: DataSchemaDescriptor = {
      version: 1,
      tables: { items: table, archivedItems: table },
    };
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-a',
          tenant: 'acme',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          tenant: 'acme',
          score: 11,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ])
      .mockResolvedValue([]);
    mocks.findApp.mockResolvedValue(liveApp());
    const baseQuery = {
      table: 'items',
      where: [{ field: 'tenant', op: 'eq', value: 'acme' }],
      orderBy: { field: 'score', direction: 'asc' },
    };

    const first = await queryDataTable(APP_ID, { ...baseQuery, limit: 1 });
    await expect(
      queryDataTable(APP_ID, {
        ...baseQuery,
        cursor: first.cursor!,
        limit: 2,
      }),
    ).resolves.toMatchObject({ items: [] });

    for (const changedQuery of [
      { ...baseQuery, table: 'archivedItems' },
      {
        ...baseQuery,
        where: [{ field: 'tenant', op: 'eq', value: 'other' }],
      },
    ]) {
      await expect(
        queryDataTable(APP_ID, {
          ...changedQuery,
          cursor: first.cursor!,
          limit: 2,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: 'Invalid Data Table cursor.',
      });
    }
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('ignores a legacy query index without changing cursor identity', async () => {
    const schema = schemaWithFields({
      score: { kind: 'integer', optional: false },
    });
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-a',
          score: 10,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
        {
          id: 'row-b',
          score: 11,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: false,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.findApp.mockResolvedValue(liveApp());

    const first = await queryDataTable(APP_ID, {
      table: 'items',
      index: 'not-declared',
      orderBy: { field: 'score', direction: 'asc' },
      limit: 1,
    });

    await expect(
      queryDataTable(APP_ID, {
        table: 'items',
        orderBy: { field: 'score', direction: 'asc' },
        cursor: first.cursor!,
        limit: 1,
      }),
    ).resolves.toMatchObject({ items: [] });
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('continues descending pagination after a SQL NULL cursor', async () => {
    const schema = schemaWithFields({
      score: { kind: 'integer', optional: true },
    });
    const { unsafe } = createHarness(schema);
    unsafe
      .mockResolvedValueOnce([
        {
          id: 'row-b',
          score: null,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: true,
        },
        {
          id: 'row-a',
          score: null,
          created_at: NOW,
          updated_at: NOW,
          __hatch_cursor_order_is_null: true,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.findApp.mockResolvedValue(liveApp());

    const first = await queryDataTable(APP_ID, {
      table: 'items',
      orderBy: { field: 'score', direction: 'desc' },
      limit: 1,
    });
    await queryDataTable(APP_ID, {
      table: 'items',
      orderBy: { field: 'score', direction: 'desc' },
      cursor: first.cursor!,
      limit: 1,
    });

    const [statement, params] = unsafe.mock.calls[1] ?? [];
    expect(statement).toContain(
      '("score" is not null or ("score" is null and "id" < $1))',
    );
    expect(params).toEqual(['row-b', 2]);
  });

  it('orders by createdAt without a matching declared index', async () => {
    const schema = schemaWithFields(
      { frequency: { kind: 'string', optional: false } },
      [{ name: 'by_frequency', fields: ['frequency'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      orderBy: { field: 'createdAt', direction: 'desc' },
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('order by "created_at" desc, "id" desc limit $1'),
      [51],
    );
  });

  it('allows filters and ordering that do not match an index shape', async () => {
    const schema = schemaWithFields(
      {
        tenant: { kind: 'string', optional: false },
        score: { kind: 'integer', optional: false },
      },
      [
        {
          name: 'by_tenant_score',
          fields: ['tenant', 'score'],
          unique: false,
        },
      ],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'score', op: 'eq', value: 10 }],
      orderBy: { field: 'score', direction: 'asc' },
    });

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'tenant', op: 'gte', value: 'acme' }],
      orderBy: { field: 'score', direction: 'desc' },
    });

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'tenant', op: 'eq', value: 'acme' }],
    });

    expect(unsafe).toHaveBeenCalledTimes(3);
    expect(unsafe.mock.calls[0]?.[0]).toContain(
      'where "score" = $1 order by "score" asc, "id" asc',
    );
    expect(unsafe.mock.calls[1]?.[0]).toContain(
      'where "tenant" >= $1 order by "score" desc, "id" desc',
    );
    expect(unsafe.mock.calls[2]?.[0]).toContain(
      'where "tenant" = $1 order by "id" asc',
    );
  });

  it('filters an indexed field without naming its index', async () => {
    const schema = schemaWithFields(
      { tenant: { kind: 'string', optional: false } },
      [{ name: 'by_tenant', fields: ['tenant'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'tenant', op: 'eq', value: 'acme' }],
    });

    expect(unsafe.mock.calls[0]?.[0]).toContain('order by "id" asc');
  });

  it('combines schema-field and id filters without naming an index', async () => {
    const schema = schemaWithFields(
      { tenant: { kind: 'string', optional: false } },
      [{ name: 'by_tenant', fields: ['tenant'], unique: false }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [
        { field: 'tenant', op: 'eq', value: 'acme' },
        { field: 'id', op: 'eq', value: 'row-1' },
      ],
    });

    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('returns revisions above the PostgreSQL int4 range', async () => {
    createHarness(schemaWithFields({}), { revision: '2147483648' });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, { table: 'items' }),
    ).resolves.toMatchObject({ revision: 2_147_483_648 });
  });

  it('queries a unique-indexed field without naming its index', async () => {
    const schema = schemaWithFields(
      { email: { kind: 'string', optional: false } },
      [{ name: 'by_email', fields: ['email'], unique: true }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'email', op: 'eq', value: 'person@example.com' }],
    });

    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('allows null filtering on a nullable unique-indexed field', async () => {
    const schema = schemaWithFields(
      { email: { kind: 'string', optional: true } },
      [{ name: 'by_email', fields: ['email'], unique: true }],
    );
    const { unsafe } = createHarness(schema);
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, {
      table: 'items',
      where: [{ field: 'email', op: 'eq', value: null }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('where "email" is null order by "id" asc'),
      [51],
    );
  });

  it('configures a bounded statement timeout for Data DB connections', async () => {
    createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await queryDataTable(APP_ID, { table: 'items' });

    expect(mocks.postgres).toHaveBeenCalledWith(expect.any(String), {
      max: 1,
      connection: { statement_timeout: 10_000 },
    });
  });

  it('stores a required JSON default null as JSON null', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false, default: null },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::text::jsonb)'),
      [expect.any(String), 'null'],
    );
    expect(result.results[0]?.payload).toBeNull();
  });

  it('binds a JSON array as text for a single PostgreSQL JSON parse', async () => {
    const payload = [
      { time: '08:00', dose: '1 tablet' },
      { time: '20:00', dose: '1 tablet' },
    ];
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: { payload } }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::text::jsonb)'),
      [expect.any(String), JSON.stringify(payload)],
    );
  });

  it('does not treat an ordinary JSON $hatch key as defaultNow', async () => {
    const payload = { $hatch: 'value', nested: true } as const;
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false, default: payload },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::text::jsonb)'),
      [expect.any(String), JSON.stringify(payload)],
    );
  });

  it('stores the exact defaultNow marker as ordinary JSON on JSON fields', async () => {
    const payload = { $hatch: 'now' } as const;
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: false, default: payload },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::text::jsonb)'),
      [expect.any(String), JSON.stringify(payload)],
    );
  });

  it('normalizes datetime values before sending them to PostgreSQL', async () => {
    const schema = schemaWithFields({
      occurredAt: { kind: 'datetime', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            occurredAt: NOW,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'insert',
          table: 'items',
          value: { occurredAt: '2026-07-13 08:00:00+08:00' },
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::timestamptz)'),
      [expect.any(String), '2026-07-13T00:00:00.000Z'],
    );
  });

  it('stores an optional datetime null as SQL NULL on insert', async () => {
    const schema = schemaWithFields({
      occurredAt: { kind: 'datetime', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            occurredAt: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'insert',
          table: 'items',
          value: { occurredAt: null },
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('values ($1, $2::timestamptz)'),
      [expect.any(String), null],
    );
    expect(result.results[0]?.occurredAt).toBeNull();
  });

  it('stores an optional datetime null as SQL NULL on patch', async () => {
    const schema = schemaWithFields({
      occurredAt: { kind: 'datetime', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            occurredAt: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'patch',
          table: 'items',
          id: 'row-1',
          value: { occurredAt: null },
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringContaining('"occurredAt" = $1::timestamptz'),
      [null, 'row-1'],
    );
    expect(result.results[0]?.occurredAt).toBeNull();
  });

  it('uses SQL NULL when an optional JSON field is omitted', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('insert into')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [{ type: 'insert', table: 'items', value: {} }],
    });

    const [statement, params] = unsafe.mock.calls[0] ?? [];
    expect(statement).toContain('("id") values ($1)');
    expect(params).toEqual([expect.any(String)]);
  });

  it('unsets an optional JSON field as SQL NULL', async () => {
    const schema = schemaWithFields({
      payload: { kind: 'json', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            payload: null,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'patch',
          table: 'items',
          id: 'row-1',
          value: {},
          unset: ['payload'],
        },
      ],
    });

    const [statement, params] = unsafe.mock.calls[0] ?? [];
    expect(statement).toContain('"payload" = null');
    expect(statement).not.toContain('"payload" = $1::text::jsonb');
    expect(params).toEqual(['row-1']);
  });

  it('increments a required numeric field with one SQL expression', async () => {
    const schema = schemaWithFields({
      value: { kind: 'integer', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      revision: '7',
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            value: 3,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'increment',
          table: 'items',
          id: 'row-1',
          field: 'value',
          amount: 2,
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(
      expect.stringMatching(
        /^update .* set "value" = "value" \+ \$1, "updated_at" = now\(\)/,
      ),
      [2, 'row-1'],
    );
    expect(result).toEqual({
      results: [
        {
          id: 'row-1',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          value: 3,
        },
      ],
      revision: 7,
    });
  });

  it('returns null when the increment target no longer exists', async () => {
    const { unsafe } = createHarness(
      schemaWithFields({ value: { kind: 'number', optional: false } }),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await mutateDataTable(APP_ID, {
      operations: [
        {
          type: 'increment',
          table: 'items',
          id: 'missing-row',
          field: 'value',
          amount: -0.5,
        },
      ],
    });

    expect(unsafe).toHaveBeenCalledWith(expect.stringMatching(/^update /), [
      -0.5,
      'missing-row',
    ]);
    expect(result.results).toEqual([null]);
  });

  it.each([
    [
      'non-numeric',
      { title: { kind: 'string' as const, optional: false } },
      'title',
      1,
      'Cannot increment non-numeric field "title".',
    ],
    [
      'optional',
      { value: { kind: 'number' as const, optional: true } },
      'value',
      1,
      'Cannot increment optional field "value".',
    ],
    [
      'fractional integer',
      { value: { kind: 'integer' as const, optional: false } },
      'value',
      0.5,
      'Invalid integer field value.',
    ],
  ])(
    'rejects a %s increment before executing SQL',
    async (_case, fields, field, amount, message) => {
      const { unsafe } = createHarness(schemaWithFields(fields));
      mocks.findApp.mockResolvedValue(liveApp());

      await expect(
        mutateDataTable(APP_ID, {
          operations: [
            {
              type: 'increment',
              table: 'items',
              id: 'row-1',
              field,
              amount,
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 400, message });
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it('rejects incrementing a system-managed field', async () => {
    const { unsafe } = createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'increment',
            table: 'items',
            id: 'row-1',
            field: 'createdAt',
            amount: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Cannot increment system field "createdAt".',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('rejects unsetting a required field', async () => {
    const { unsafe } = createHarness(
      schemaWithFields({ title: { kind: 'string', optional: false } }),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'patch',
            table: 'items',
            id: 'row-1',
            value: {},
            unset: ['title'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Cannot unset required field "title".',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('rejects updating and unsetting the same field', async () => {
    const { unsafe } = createHarness(
      schemaWithFields({ note: { kind: 'string', optional: true } }),
    );
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'patch',
            table: 'items',
            id: 'row-1',
            value: { note: 'Updated' },
            unset: ['note'],
          },
        ],
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Data Table field "note" cannot be both updated and unset.',
    });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it.each(['id', 'createdAt', 'updatedAt'])(
    'rejects the system-managed insert field %s',
    async (field) => {
      const { unsafe } = createHarness(schemaWithFields({}));
      mocks.findApp.mockResolvedValue(liveApp());

      await expect(
        mutateDataTable(APP_ID, {
          operations: [
            {
              type: 'insert',
              table: 'items',
              value: { [field]: 'caller-controlled' },
            },
          ],
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(unsafe).not.toHaveBeenCalled();
    },
  );

  it('does not resolve query names through Object.prototype', async () => {
    const { unsafe } = createHarness(schemaWithFields({}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, {
        table: 'items',
        where: [{ field: 'toString', op: 'eq', value: 'x' }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('reads estimated counts only after releasing the migration guard', async () => {
    const events: string[] = [];
    const { unsafe } = createHarness(schemaWithFields({}), {
      events,
      unsafe: async (statement) => {
        if (statement.includes('from pg_class')) {
          events.push('estimate');
          return [{ name: 'items', estimated_count: 42.6 }];
        }
        throw new Error(`Unexpected unsafe SQL in test: ${statement}`);
      },
    });
    mocks.findApp.mockImplementation(async () => {
      events.push('platform');
      return liveApp();
    });

    const result = await inspectDataTables(APP_ID);

    expect(result?.tables).toEqual([{ name: 'items', rowCount: 43 }]);
    expect(events).toEqual(['lock', 'platform', 'transaction-end', 'estimate']);
    expect(unsafe.mock.calls[0]?.[0]).not.toContain('count(*)');
  });

  it('rolls back a patch whose final stored row exceeds the size limit', async () => {
    const value = 'x'.repeat(140 * 1024);
    const schema = schemaWithFields({
      first: { kind: 'string', optional: true },
      second: { kind: 'string', optional: true },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            first: value,
            second: value,
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(APP_ID, {
        operations: [
          {
            type: 'patch',
            table: 'items',
            id: 'row-1',
            value: { second: value },
          },
        ],
      }),
    ).rejects.toMatchObject({ status: 413 });
    expect(unsafe).toHaveBeenCalledWith(expect.stringMatching(/^update /), [
      value,
      'row-1',
    ]);
  });

  it('rolls back an Agent mutation whose complete result exceeds its budget', async () => {
    const schema = schemaWithFields({
      body: { kind: 'string', optional: false },
    });
    const { unsafe } = createHarness(schema, {
      unsafe: async (statement) => {
        if (!statement.startsWith('update')) return [];
        return [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            body: 'x'.repeat(70_000),
          },
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      mutateDataTable(
        APP_ID,
        {
          operations: [
            {
              type: 'patch',
              table: 'items',
              id: 'row-1',
              value: { body: 'updated' },
            },
          ],
        },
        { resultMaxChars: 60_000 },
      ),
    ).rejects.toMatchObject({
      status: 413,
      message: expect.stringMatching(/entire batch was rolled back/i),
    });
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('rejects an oversized stored row returned by a query', async () => {
    const value = 'x'.repeat(256 * 1024);
    const { unsafe } = createHarness(
      schemaWithFields({ title: { kind: 'string', optional: false } }),
      {
        unsafe: async () => [
          {
            id: 'row-1',
            created_at: NOW,
            updated_at: NOW,
            title: value,
            __hatch_cursor_order_is_null: false,
          },
        ],
      },
    );
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      queryDataTable(APP_ID, { table: 'items' }),
    ).rejects.toMatchObject({
      status: 413,
      message: 'Data Table row exceeds 262144 bytes.',
    });
    expect(unsafe).toHaveBeenCalledOnce();
  });

  it('runs raw SQL after taking the migration guard and setting local bounds', async () => {
    const events: string[] = [];
    createRawHarness({
      events,
      query: async () => [
        rawResult([{ answer: 42 }], 'SELECT', 1),
        rawResult([], 'UPDATE', 3),
      ],
    });
    mocks.findApp.mockImplementation(async () => {
      events.push('platform');
      return liveApp();
    });

    const result = await executeDataTableRawSql(
      APP_ID,
      'select 42 as answer; update items set updated_at = now()',
      45_000,
    );

    const [url, config] = mocks.postgres.mock.calls[0] as [
      string,
      {
        max: number;
        connect_timeout: number;
        connection: { statement_timeout: number };
      },
    ];
    expect(url).toBe('postgres://data:data@127.0.0.1:5432/data');
    expect(config).toMatchObject({
      max: 1,
      connection: { statement_timeout: 45_000 },
    });
    expect(config.connect_timeout).toBeGreaterThan(0);
    expect(config.connect_timeout).toBeLessThanOrEqual(45);
    expect(events).toEqual([
      'begin',
      'select pg_try_advisory_xact_lock_shared($1) as ok',
      'platform',
      'set local statement_timeout = 45000',
      'set local search_path = data, public',
      'select 42 as answer; update items set updated_at = now()',
      'commit',
    ]);
    expect(result).toEqual({
      results: [
        { command: 'SELECT', count: 1, rows: [{ answer: 42 }] },
        { command: 'UPDATE', count: 3, rows: [] },
      ],
      truncated: false,
    });
  });

  it('schedules detached retention after a confirmed raw SQL commit', async () => {
    let resolvePrune!: (value: unknown[]) => void;
    const pendingPrune = new Promise<unknown[]>((resolve) => {
      resolvePrune = resolve;
    });
    const pruneQuery = vi.fn<TaggedHandler>(async () => pendingPrune);
    const pruneEnd = vi.fn<EndHandler>(async () => {});
    mocks.postgres.mockReturnValue(
      Object.assign(pruneQuery, { end: pruneEnd }),
    );
    createRawHarness({
      query: async () => rawResult([], 'UPDATE', 1),
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    const settled = vi.fn<(value: unknown) => void>();
    const running = executeDataTableRawSql(
      APP_ID,
      'update items set updated_at = now()',
      30_000,
    );
    void running.then(settled);

    await vi.waitFor(() => expect(pruneQuery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    const statement = pruneQuery.mock.calls[0][0]
      .join('?')
      .replaceAll(/\s+/g, ' ')
      .trim();
    expect(statement).toContain('delete from _hatch.changes');
    resolvePrune([]);
    await expect(running).resolves.toMatchObject({
      results: [{ command: 'UPDATE', count: 1 }],
    });
    await vi.waitFor(() => expect(pruneEnd).toHaveBeenCalledOnce());
  });

  it('does not fail committed raw SQL when detached retention cannot start', async () => {
    createRawHarness({
      query: async () => rawResult([], 'UPDATE', 1),
    });
    mocks.postgres.mockImplementationOnce(() => {
      throw new Error('Data database no longer exists');
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await expect(
      executeDataTableRawSql(
        APP_ID,
        'update items set updated_at = now()',
        30_000,
      ),
    ).resolves.toMatchObject({
      results: [{ command: 'UPDATE', count: 1 }],
    });
    // The raw SQL client, then the detached retention client.
    await vi.waitFor(() => expect(mocks.postgres).toHaveBeenCalledTimes(2));
  });

  it('does not fail committed raw SQL when detached retention deletion fails', async () => {
    const pruneError = new Error('retention delete failed');
    const pruneQuery = vi.fn<TaggedHandler>(async () => {
      throw pruneError;
    });
    const pruneEnd = vi.fn<EndHandler>(async () => {});
    mocks.postgres.mockReturnValue(
      Object.assign(pruneQuery, { end: pruneEnd }),
    );
    createRawHarness({
      query: async () => rawResult([], 'UPDATE', 1),
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await expect(
      executeDataTableRawSql(
        APP_ID,
        'update items set updated_at = now()',
        30_000,
      ),
    ).resolves.toMatchObject({
      results: [{ command: 'UPDATE', count: 1 }],
    });
    await vi.waitFor(() => expect(pruneQuery).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(pruneEnd).toHaveBeenCalledOnce());
  });

  it('does not schedule retention after raw SQL rolls back', async () => {
    const databaseError = Object.assign(new Error('invalid value'), {
      code: '22P02',
    });
    const { events } = createRawHarness({
      query: async () => {
        throw databaseError;
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await expect(
      executeDataTableRawSql(APP_ID, 'select broken from items', 30_000),
    ).rejects.toMatchObject({ status: 400 });
    expect(events.at(-1)).toBe('rollback');
    expect(globalState.__hatchDataLastPrune.has(APP_ID)).toBe(false);
    // Only the raw SQL client was opened; no retention client followed.
    expect(mocks.postgres).toHaveBeenCalledOnce();
  });

  it('throttles retention across successful raw SQL calls', async () => {
    const pruneQuery = vi.fn<TaggedHandler>(async () => []);
    mocks.postgres.mockReturnValue(
      Object.assign(pruneQuery, { end: vi.fn<EndHandler>(async () => {}) }),
    );
    createRawHarness({
      query: async () => rawResult([{ answer: 42 }], 'SELECT', 1),
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await executeDataTableRawSql(APP_ID, 'select 42 as answer', 30_000);
    await vi.waitFor(() => expect(pruneQuery).toHaveBeenCalledOnce());
    createRawHarness({
      query: async () => rawResult([{ answer: 42 }], 'SELECT', 1),
    });
    await executeDataTableRawSql(APP_ID, 'select 42 as answer', 30_000);
    await Promise.resolve();

    expect(pruneQuery).toHaveBeenCalledOnce();
  });

  it('serializes an out-of-range PostgreSQL timestamp without throwing', async () => {
    createRawHarness({
      query: async () =>
        rawResult([{ timestamp: new Date(Number.NaN) }], 'SELECT', 1),
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      executeDataTableRawSql(
        APP_ID,
        "select '294276-12-31 23:59:59.999999'::timestamp as timestamp",
        30_000,
      ),
    ).resolves.toMatchObject({
      results: [
        { command: 'SELECT', count: 1, rows: [{ timestamp: 'Invalid Date' }] },
      ],
    });
  });

  it('turns a raw row processing failure into a rollback and bounded error', async () => {
    const processingError = new Error('row getter failed');
    const brokenRow: Record<string, unknown> = {};
    Object.defineProperty(brokenRow, 'broken', {
      enumerable: true,
      get() {
        throw processingError;
      },
    });
    const { events } = createRawHarness({
      query: async () => rawResult([brokenRow], 'SELECT', 1),
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      executeDataTableRawSql(APP_ID, 'select broken from items', 30_000),
    ).rejects.toMatchObject({
      status: 500,
      cause: processingError,
      message: 'row getter failed',
    });
    expect(events).toContain('rollback');
  });

  it('checks the activation fence after locking raw SQL', async () => {
    const events: string[] = [];
    const userQuery = vi.fn<RawQueryHandler>(async () =>
      rawResult([], 'SELECT', 0),
    );
    createRawHarness({ events, query: userQuery });
    mocks.findApp.mockImplementation(async () => {
      events.push('platform');
      return liveApp({ dataActivationId: 'pending-deployment' });
    });

    await expect(
      executeDataTableRawSql(APP_ID, 'select 1', 30_000),
    ).rejects.toMatchObject({ status: 503 });

    expect(events).toEqual([
      'begin',
      'select pg_try_advisory_xact_lock_shared($1) as ok',
      'platform',
      'rollback',
    ]);
    expect(userQuery).not.toHaveBeenCalled();
  });

  it('does not inspect or reject DDL in raw SQL at runtime', async () => {
    const userQuery = vi.fn<RawQueryHandler>(async () =>
      rawResult([], 'CREATE TABLE', null),
    );
    createRawHarness({ query: userQuery });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      executeDataTableRawSql(
        APP_ID,
        'create table forbidden_by_text_only()',
        30_000,
      ),
    ).resolves.toEqual({
      results: [{ command: 'CREATE TABLE', count: null, rows: [] }],
      truncated: false,
    });
    expect(userQuery.mock.calls[0]?.[0]).toBe(
      'create table forbidden_by_text_only()',
    );
  });

  it('truncates raw output only between complete rows', async () => {
    createRawHarness({
      query: async () => {
        return rawResult(
          [
            { id: 'row-a', body: 'a'.repeat(35_000) },
            { id: 'row-b', body: 'b'.repeat(35_000) },
          ],
          'SELECT',
          2,
        );
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await executeDataTableRawSql(
      APP_ID,
      'select * from items',
      30_000,
    );

    expect(result.results[0]).toMatchObject({
      command: 'SELECT',
      count: 2,
      rows: [{ id: 'row-a', body: 'a'.repeat(35_000) }],
    });
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.results, null, 2).length).toBeLessThanOrEqual(
      60_000,
    );
  });

  it('previews a single raw row that exceeds the output budget', async () => {
    createRawHarness({
      query: async () =>
        rawResult([{ payload: 'x'.repeat(100_000) }], 'SELECT', 1),
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await executeDataTableRawSql(
      APP_ID,
      'select payload from items',
      30_000,
    );

    expect(result.truncated).toBe(true);
    expect(result.results[0].rows[0]).toMatchObject({
      __hatch_preview: expect.stringContaining('"payload"'),
      __hatch_preview_notice: expect.stringContaining('preview is incomplete'),
    });
    expect(JSON.stringify(result.results, null, 2).length).toBeLessThanOrEqual(
      60_000,
    );
  });

  it('caps raw SQL output at 100 rows across result sets', async () => {
    createRawHarness({
      query: async () => {
        return [
          rawResult(
            Array.from({ length: 60 }, (_, index) => ({ index })),
            'SELECT',
            60,
          ),
          rawResult(
            Array.from({ length: 60 }, (_, index) => ({ index: index + 60 })),
            'SELECT',
            60,
          ),
        ];
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await executeDataTableRawSql(
      APP_ID,
      'select 1; select 2',
      30_000,
    );

    expect(result.results.flatMap((item) => item.rows)).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('does not call an exact 100-row raw result truncated', async () => {
    createRawHarness({
      query: async () => [
        rawResult(
          Array.from({ length: 100 }, (_, index) => ({ index })),
          'SELECT',
          100,
        ),
        rawResult([], 'UPDATE', 3),
      ],
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const result = await executeDataTableRawSql(
      APP_ID,
      'select index from items limit 100',
      30_000,
    );

    expect(result.results[0].rows).toHaveLength(100);
    expect(result.results[1]).toEqual({
      command: 'UPDATE',
      count: 3,
      rows: [],
    });
    expect(result.truncated).toBe(false);
  });

  it('rejects invalid raw SQL timeout bounds before opening a database', async () => {
    for (const timeoutMs of [999, 1_800_001, 1.5]) {
      await expect(
        executeDataTableRawSql(APP_ID, 'select 1', timeoutMs),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it('maps PostgreSQL statement cancellation to a raw SQL timeout', async () => {
    const statementTimeout = Object.assign(new Error('canceling statement'), {
      code: '57014',
    });
    const { events } = createRawHarness({
      query: async () => {
        throw statementTimeout;
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      executeDataTableRawSql(APP_ID, 'select pg_sleep(2)', 1_000),
    ).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining('1000'),
    });
    expect(events.at(-1)).toBe('rollback');
  });

  it('bounds PostgreSQL error text before returning it to the Agent', async () => {
    const databaseError = Object.assign(new Error('x'.repeat(70_000)), {
      code: '22P02',
    });
    createRawHarness({
      query: async () => {
        throw databaseError;
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const error = await executeDataTableRawSql(
      APP_ID,
      `select repeat('x', 70000)::integer`,
      30_000,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 400,
      cause: databaseError,
      message: expect.stringMatching(/^PostgreSQL 22P02: /),
    });
    expect((error as Error).message.length).toBeLessThanOrEqual(4_000);
  });

  it.each(['08006', '53P01', '57P01', '58P01', 'XX000'])(
    'keeps PostgreSQL infrastructure error %s as a server error',
    async (code) => {
      const databaseError = Object.assign(new Error('database unavailable'), {
        code,
      });
      createRawHarness({
        query: async () => {
          throw databaseError;
        },
      });
      mocks.findApp.mockResolvedValue(liveApp());

      await expect(
        executeDataTableRawSql(APP_ID, 'select 1', 30_000),
      ).rejects.toMatchObject({
        status: 500,
        cause: databaseError,
        message: `PostgreSQL ${code}: database unavailable`,
      });
    },
  );

  it.each(['23503', '23505', '23P01'])(
    'maps PostgreSQL data conflict %s to a conflict response',
    async (code) => {
      const databaseError = Object.assign(new Error('data conflict'), {
        code,
      });
      createRawHarness({
        query: async () => {
          throw databaseError;
        },
      });
      mocks.findApp.mockResolvedValue(liveApp());

      await expect(
        executeDataTableRawSql(APP_ID, 'insert into items values (1)', 30_000),
      ).rejects.toMatchObject({
        status: 409,
        cause: databaseError,
        message: `PostgreSQL ${code}: data conflict`,
      });
    },
  );

  it('maps a connection failure to a bounded server error', async () => {
    const connectionError = Object.assign(new Error('connection refused'), {
      code: 'ECONNREFUSED',
    });
    createRawHarness({
      reserve: async () => {
        throw connectionError;
      },
    });

    await expect(
      executeDataTableRawSql(APP_ID, 'select 1', 30_000),
    ).rejects.toMatchObject({
      status: 500,
      cause: connectionError,
      message: 'connection refused',
    });
  });

  it('cancels the running statement before closing it at the timeout', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const { client, events, canceled } = createRawHarness({
      // A running statement only ends when PostgreSQL acts on the cancel.
      query: async () => new Promise<never>(() => {}),
    });
    client.end.mockImplementation(async () => {
      order.push(`end after ${canceled.length} cancel`);
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const settled = executeDataTableRawSql(
      APP_ID,
      'select pg_sleep(60)',
      1_000,
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(events).toContain('select pg_sleep(60)'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(settled).resolves.toMatchObject({
      status: 504,
      message: expect.stringContaining('1000'),
    });
    expect(canceled).toEqual(['select pg_sleep(60)']);
    await vi.waitFor(() => expect(order).toEqual(['end after 1 cancel']));
    expect(events).not.toContain('rollback');
  });

  it('does not wait forever for teardown after the database timeout', async () => {
    vi.useFakeTimers();
    const { client, events } = createRawHarness();
    // The platform check never answers, and closing the socket never
    // completes either: the caller still gets its timeout.
    mocks.findApp.mockImplementation(async () => new Promise<never>(() => {}));
    client.end.mockImplementation(async () => new Promise<void>(() => {}));

    const settled = executeDataTableRawSql(
      APP_ID,
      'select pg_sleep(60)',
      1_000,
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(events).toContain('begin'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(settled).resolves.toMatchObject({ status: 504 });
    expect(client.end).toHaveBeenCalled();
  });

  it('closes a stopped connection after a grace period when cancel is ignored', async () => {
    vi.useFakeTimers();
    const { client, events, canceled } = createRawHarness({
      // Neither the statement nor its cancellation ever settles.
      query: async () => new Promise<never>(() => {}),
      ignoreCancel: true,
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const settled = executeDataTableRawSql(
      APP_ID,
      'select pg_sleep(60)',
      1_000,
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(events).toContain('select pg_sleep(60)'));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(settled).resolves.toMatchObject({ status: 504 });
    expect(canceled).toEqual(['select pg_sleep(60)']);
    expect(client.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('does not delay a committed result while connection teardown is pending', async () => {
    const { client } = createRawHarness({
      query: async () => rawResult([{ answer: 42 }], 'SELECT', 1),
    });
    client.end.mockImplementation(async () => new Promise<void>(() => {}));
    mocks.findApp.mockResolvedValue(liveApp());

    await expect(
      executeDataTableRawSql(APP_ID, 'select 42 as answer', 30_000),
    ).resolves.toMatchObject({
      results: [{ command: 'SELECT', count: 1, rows: [{ answer: 42 }] }],
    });
    expect(client.end).toHaveBeenCalled();
  });

  it('cancels raw SQL and closes its connection when the Agent aborts', async () => {
    const { client, events, canceled } = createRawHarness({
      query: async () => new Promise<never>(() => {}),
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const abort = new AbortController();

    const running = executeDataTableRawSql(
      APP_ID,
      'select pg_sleep(60)',
      30_000,
      abort.signal,
    );
    await vi.waitFor(() => expect(events).toContain('select pg_sleep(60)'));
    abort.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(canceled).toEqual(['select pg_sleep(60)']);
    await vi.waitFor(() => expect(client.end).toHaveBeenCalled());
  });

  it('reports an unknown outcome when the database timeout fires during COMMIT', async () => {
    vi.useFakeTimers();
    let resolveCommit!: (result: RawQueryResult) => void;
    const { client, events, canceled } = createRawHarness({
      query: async () => rawResult([], 'UPDATE', 1),
      commit: async () =>
        new Promise<RawQueryResult>((resolve) => {
          resolveCommit = resolve;
        }),
    });
    mocks.findApp.mockResolvedValue(liveApp());

    const settled = executeDataTableRawSql(
      APP_ID,
      'update items set updated_at = now()',
      1_000,
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(events).toContain('commit'));
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(settled).resolves.toMatchObject({
      status: 409,
      message: expect.stringMatching(/outcome is unknown.*do not retry/is),
    });
    expect(events).not.toContain('rollback');
    expect(canceled).toEqual([]);
    // The connection stays open until COMMIT has an answer from the server.
    expect(client.end).not.toHaveBeenCalled();
    resolveCommit(rawResult([], 'COMMIT', null));
    await vi.waitFor(() => expect(client.end).toHaveBeenCalledOnce());
  });

  it('reports an unknown outcome when the COMMIT acknowledgement is lost', async () => {
    const connectionError = Object.assign(new Error('connection reset'), {
      code: 'CONNECTION_CLOSED',
    });
    const { events } = createRawHarness({
      query: async () => rawResult([], 'UPDATE', 1),
      commit: async () => {
        throw connectionError;
      },
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await expect(
      executeDataTableRawSql(
        APP_ID,
        'update items set updated_at = now()',
        30_000,
      ),
    ).rejects.toMatchObject({
      status: 409,
      cause: connectionError,
      message: expect.stringMatching(/inspect the affected data first/i),
    });
    expect(events).not.toContain('rollback');
    expect(globalState.__hatchDataLastPrune.has(APP_ID)).toBe(false);
    expect(mocks.postgres).toHaveBeenCalledOnce();
  });

  it('handles detached retention failure after a committed mutation', async () => {
    const { client } = createHarness(schemaWithFields({}));
    mocks.postgres.mockReturnValueOnce(client).mockImplementationOnce(() => {
      throw new Error('Data database no longer exists');
    });
    mocks.findApp.mockResolvedValue(liveApp());
    const globalState = globalThis as typeof globalThis & {
      __hatchDataLastPrune?: Map<string, number>;
    };
    globalState.__hatchDataLastPrune = new Map();

    await expect(
      mutateDataTable(APP_ID, {
        operations: [{ type: 'delete', table: 'items', id: 'row-1' }],
      }),
    ).resolves.toMatchObject({ results: [null] });
    await vi.waitFor(() => expect(mocks.postgres).toHaveBeenCalledTimes(2));
  });
});
