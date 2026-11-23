import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

vi.mock('~server/agent-runner/hub', () => ({
  RunDispatchUncertainError: class extends Error {},
  RunNotStartedError: class extends Error {},
  connectedRunnerCount: () => 1,
  listConnectedRunners: () => [{ runnerId: 'runner-pg' }],
  dispatchRun: async (
    _payload: unknown,
    plan: {
      assign(runnerId: string): Promise<void>;
      finalize(runnerId: string): Promise<string>;
    },
  ) => {
    await plan.assign('runner-pg');
    await plan.finalize('runner-pg');
    return 'runner-pg';
  },
  sendRunCancel: () => false,
  sendRunSteer: () => true,
  waitForRunFinished: async () => {},
}));

/**
 * Pending-message delivery locks rows through a join and filters claims with
 * a subquery; these run the real migrations and the production postgres.js
 * driver, which PGlite does not exercise.
 */
describe.skipIf(!adminUrl)('pending messages on PostgreSQL', () => {
  const database = `hatch_pending_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let platform: typeof import('~/db');
  let runs: typeof import('./agent-runs');
  let pending: typeof import('./agent-pending-messages');

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
    pending = await import('./agent-pending-messages');
  }, 60_000);

  afterAll(async () => {
    await runs?.pendingDispatchesSettled();
    await platform?.db.$client.end({ timeout: 1 });
    await admin?.unsafe(`drop database if exists "${database}" with (force)`);
    await admin?.end();
    vi.unstubAllEnvs();
  }, 30_000);

  it('claims, settles and redelivers steer messages', async () => {
    const { db, schema } = platform;
    await db.insert(schema.user).values({
      id: 'user-pg',
      name: 'Ada',
      email: 'ada@pg.test',
    });
    await db.insert(schema.agentProviders).values({
      id: 'provider-pg',
      name: 'Provider',
      apiType: 'openai-responses',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'key',
    });
    await db.insert(schema.agentModels).values({
      providerId: 'provider-pg',
      modelId: 'model-pg',
      name: 'Model',
      contextWindow: 128_000,
      maxTokens: 8_192,
    });
    await db.insert(schema.agentSessions).values({ id: 'session-pg' });
    const model = { providerId: 'provider-pg', modelId: 'model-pg' };
    const { runId } = await runs.startAgentRun({
      sessionId: 'session-pg',
      content: [{ type: 'text', text: 'Build it' }],
      ...model,
      userId: 'user-pg',
    });
    for (const text of ['Use blue', 'And dark']) {
      await pending.enqueuePendingMessage({
        sessionId: 'session-pg',
        userId: 'user-pg',
        ...model,
        message: { content: [{ type: 'text', text }] },
      });
    }
    const claimed = await runs.claimSteerMessages('runner-pg', runId);
    expect(claimed.map((message) => message.userText)).toEqual([
      'Use blue',
      'And dark',
    ]);
    await runs.ingestRunnerEvent('runner-pg', {
      runId,
      runnerSeq: 1,
      event: {
        type: 'user_message',
        pendingId: claimed[0].id,
        text: 'Use blue',
        images: [],
      },
    });
    // Stopped before the report: the run's claims return to the tray.
    await runs.cancelAgentRun(runId);
    await runs.pendingDispatchesSettled();
    const tray = await pending.getPendingMessages('session-pg');
    expect(tray.paused).toBe(true);
    expect(tray.messages.map((message) => message.status)).toEqual([
      'pending',
      'pending',
    ]);

    const resumed = await pending.resumePendingMessages('session-pg');
    expect(resumed.startedRunId).not.toBeNull();
    expect(resumed.pending).toEqual({ paused: false, messages: [] });
    const next = await runs.getAgentRun(resumed.startedRunId!);
    expect(next?.input).toMatchObject({ userText: 'Use blue\n\nAnd dark' });
    expect(next?.userId).toBe('user-pg');
  });
});
