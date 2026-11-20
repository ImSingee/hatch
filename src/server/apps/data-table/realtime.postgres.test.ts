import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDataRealtime,
  type DataChange,
  subscribeDataChanges,
} from './realtime';

const adminUrl = process.env.DATA_TABLE_TEST_DATABASE_URL;
const state = vi.hoisted(() => ({ databaseUrl: '' }));

vi.mock('./provision', () => ({
  resolveAppDataDatabaseUrl: async () => state.databaseUrl,
}));
vi.mock('./service', () => ({
  acquireDataReadGuard: async () => {},
  assertDataTableAccess: async () => {},
}));

/**
 * Realtime treats LISTEN/NOTIFY as a wake-up hint over a durable change log.
 * These checks pin the driver behavior it relies on against a real server:
 * notifications arrive, and a dropped LISTEN connection reconnects and
 * replays what changed while it was gone.
 */
describe.skipIf(!adminUrl)('Data Table realtime on PostgreSQL', () => {
  const appId = `realtime-${process.pid}-${Date.now()}`;
  const database = `hatch_realtime_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let data: postgres.Sql;
  const received: DataChange[] = [];

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    state.databaseUrl = url.toString();
    data = postgres(state.databaseUrl, { max: 1, onnotice: () => {} });
    await data.unsafe('create schema _hatch');
    await data.unsafe(`
      create table _hatch.changes (
        seq bigserial primary key,
        table_name text not null,
        row_id text,
        operation text not null,
        created_at timestamptz not null default now()
      )
    `);
    await subscribeDataChanges({
      id: appId,
      since: 0,
      send: (event) => {
        if (!('reset' in event)) received.push(event);
      },
    });
  }, 30_000);

  afterAll(async () => {
    // Closing the App's realtime waits for its LISTEN client to end.
    await closeDataRealtime(appId);
    await data?.end();
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    // CREATE and DROP DATABASE checkpoint, which can be slow on a loaded host.
  }, 30_000);

  async function recordChange(rowId: string, notify: boolean) {
    const [change] = await data<{ seq: string }[]>`
      insert into _hatch.changes (table_name, row_id, operation)
      values ('todos', ${rowId}, 'insert') returning seq::text
    `;
    if (notify) {
      await data`select pg_notify('hatch_data_changes', ${change!.seq})`;
    }
  }

  async function listenerPids(): Promise<number[]> {
    const rows = await admin<{ pid: number }[]>`
      select pid from pg_stat_activity
      where datname = ${database} and query ilike 'listen%'
    `;
    return rows.map((row) => row.pid);
  }

  it('delivers a change announced by NOTIFY', async () => {
    await recordChange('todo-1', true);

    await vi.waitFor(
      () =>
        expect(received).toContainEqual(
          expect.objectContaining({ table: 'todos', rowId: 'todo-1' }),
        ),
      { timeout: 5_000 },
    );
  });

  it('replays changes made while the LISTEN connection was down', async () => {
    // Committed without a NOTIFY, as when the hint is lost with its
    // connection: only the replay after the LISTEN reconnect delivers it.
    await recordChange('todo-2', false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received.map((change) => change.rowId)).not.toContain('todo-2');
    const [pid] = await listenerPids();
    expect(pid).toBeTypeOf('number');
    await admin`select pg_terminate_backend(${pid!})`;

    await vi.waitFor(
      () =>
        expect(received).toContainEqual(
          expect.objectContaining({ table: 'todos', rowId: 'todo-2' }),
        ),
      { timeout: 10_000 },
    );
    const reconnected = await listenerPids();
    expect(reconnected).toHaveLength(1);
    expect(reconnected[0]).not.toBe(pid);
  }, 15_000);
});
