import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeDataTableRawSql } from './service';

const databaseUrl = process.env.DATA_TABLE_TEST_DATABASE_URL;

vi.mock('~/db', () => ({
  db: {
    query: {
      apps: {
        findFirst: async () => ({
          status: 'deployed',
          currentDeploymentId: 'deployment',
          capabilities: { dataTable: true },
          dataActivationId: null,
        }),
      },
    },
  },
}));
vi.mock('./provision', () => ({
  resolveAppDataDatabaseUrl: async () =>
    process.env.DATA_TABLE_TEST_DATABASE_URL,
}));

/**
 * Raw SQL runs Agent-issued statements through the driver's simple protocol.
 * These checks pin the driver behavior it relies on against a real server.
 */
describe.skipIf(!databaseUrl)('Data Table raw SQL on PostgreSQL', () => {
  const table = `raw_sql_${process.pid}_${Date.now()}`;
  const marker = `raw_sql_sleep_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe('create schema if not exists data');
    await admin.unsafe(`create table data."${table}" (id int primary key)`);
  });

  afterAll(async () => {
    await admin.unsafe(`drop table if exists data."${table}"`);
    await admin.end();
  });

  async function activeSleeps(): Promise<number> {
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where state = 'active' and query like ${`%${marker}%`}
        and pid <> pg_backend_pid()
    `;
    return row?.count ?? 0;
  }

  it('returns every statement result and commits them together', async () => {
    const result = await executeDataTableRawSql(
      'app',
      `insert into "${table}" values (1), (2);` +
        `select id from "${table}" order by id;` +
        `update "${table}" set id = id + 10 where id = 2`,
      10_000,
    );

    expect(result).toEqual({
      results: [
        { command: 'INSERT', count: 2, rows: [] },
        { command: 'SELECT', count: 2, rows: [{ id: 1 }, { id: 2 }] },
        { command: 'UPDATE', count: 1, rows: [] },
      ],
      truncated: false,
    });
    const rows = await admin`select id from data.${admin(table)} order by id`;
    expect(rows.map((row) => row.id)).toEqual([1, 12]);
  });

  it('rolls back earlier statements when a later one fails', async () => {
    await expect(
      executeDataTableRawSql(
        'app',
        `insert into "${table}" values (100); select 1 / 0`,
        10_000,
      ),
    ).rejects.toMatchObject({ status: 400, message: /^PostgreSQL 22012: / });
    const rows = await admin`
      select id from data.${admin(table)} where id = 100
    `;
    expect(rows).toHaveLength(0);
  });

  it('stops the running statement on the server at the timeout', async () => {
    const started = Date.now();
    await expect(
      executeDataTableRawSql(
        'app',
        `select pg_sleep(30) as "${marker}"`,
        1_000,
      ),
    ).rejects.toMatchObject({ status: 504 });
    expect(Date.now() - started).toBeLessThan(5_000);
    await vi.waitFor(async () => expect(await activeSleeps()).toBe(0), {
      timeout: 3_000,
    });
  });

  it('stops the running statement on the server when aborted', async () => {
    const abort = new AbortController();
    const running = executeDataTableRawSql(
      'app',
      `select pg_sleep(30) as "${marker}"`,
      30_000,
      abort.signal,
    );
    await vi.waitFor(async () => expect(await activeSleeps()).toBe(1), {
      timeout: 5_000,
    });
    abort.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect(await activeSleeps()).toBe(0), {
      timeout: 3_000,
    });
  });
});
