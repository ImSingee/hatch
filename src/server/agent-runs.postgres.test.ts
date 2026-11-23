import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

vi.mock('~server/agent-runner/hub', () => ({
  RunNotStartedError: class extends Error {},
  sendRunCancel: () => false,
}));

/**
 * The unit suite runs on PGlite, which binds parameters differently from the
 * production postgres.js client. These checks run the platform's own
 * migrator and run-event storage on a real server.
 */
describe.skipIf(!adminUrl)('Agent run events on PostgreSQL', () => {
  const database = `hatch_agent_runs_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let platform: typeof import('~/db');
  let runs: typeof import('./agent-runs');

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${database}"`);
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    vi.stubEnv('DATABASE_URL', url.toString());
    const { runMigrations } = await import('~/db/migrate');
    await runMigrations();
    platform = await import('~/db');
    runs = await import('./agent-runs');
  }, 60_000);

  afterAll(async () => {
    await platform?.db.$client.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    vi.unstubAllEnvs();
    // CREATE and DROP DATABASE checkpoint, which can be slow on a loaded host.
  }, 30_000);

  it('stores a run event as a JSON object, not as an encoded string', async () => {
    const { db, schema } = platform;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await db.insert(schema.agentSessions).values({ id: sessionId });
    await db.insert(schema.agentRuns).values({
      id: runId,
      sessionId,
      providerId: 'fixture',
      modelId: 'fixture',
      input: { text: 'Store an event' },
    });

    await runs.cancelAgentRun(runId);

    expect(await runs.listRunEventsAfter(runId, 0)).toEqual([
      { seq: 1, event: { type: 'cancelled' } },
    ]);
    const [row] = (await db.execute(sql`
      select jsonb_typeof(payload) as kind from agent_run_events
      where run_id = ${runId}
    `)) as unknown as { kind: string }[];
    expect(row?.kind).toBe('object');
  });
});
