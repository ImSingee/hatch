import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DedicatedRunOptions, DedicatedRunResult } from '../runtime';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

type Launch = {
  options: DedicatedRunOptions;
  finish: (result: Partial<DedicatedRunResult>) => void;
  killed: boolean;
  done: boolean;
};

const launches: Launch[] = [];

vi.mock('../runtime', () => ({
  runInDedicatedInstance: (_appId: string, options: DedicatedRunOptions) =>
    new Promise<DedicatedRunResult>((resolve) => {
      const launch: Launch = {
        options,
        killed: false,
        done: false,
        finish: (result) => {
          launch.done = true;
          resolve({
            deploymentId: 'dep-1',
            response: null,
            error: null,
            ...result,
          });
        },
      };
      options.onSpawn?.({
        deploymentId: 'dep-1',
        pid: 1,
        kill: () => {
          launch.killed = true;
          launch.finish({ error: 'killed' });
        },
      });
      options.signal?.addEventListener('abort', () =>
        launch.finish({ error: 'aborted' }),
      );
      launches.push(launch);
    }),
}));

const { db, schema } = await import('~/db');
const {
  cancelTaskRun,
  getTaskRun,
  loadTaskCronJobs,
  recoverTaskRuns,
  startTaskRun,
} = await import('./service');

const APP = 'tasks-app';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error('condition not met');
}

async function seed(
  tasks: { concurrency: number; definitions: unknown[] },
  status: 'deployed' | 'archived' = 'deployed',
) {
  await db.delete(schema.apps);
  await db.insert(schema.apps).values({
    id: APP,
    slug: APP,
    name: 'Tasks',
    status,
    capabilities: {
      database: false,
      frontend: false,
      widgets: false,
      backend: true,
      cron: false,
      webhook: false,
      kv: false,
      tasks: true,
    },
    signingSecret: 'signing-secret',
    currentDeploymentId: 'dep-1',
  });
  await db.insert(schema.deployments).values({
    id: 'dep-1',
    appId: APP,
    version: 3,
    compatibilityVersion: 2,
    status: 'deployed',
    manifestNormalized: {
      rpc: { url: '', service: 'app.v1.Svc' },
      tasks,
    } as never,
  });
}

const digest = {
  name: 'digest',
  method: 'RunDigest',
  cron: [],
  webhook: false,
  inputType: 'app.v1.Req',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', pattern: '^[^/]+/[^/]+$' },
      limit: { type: 'integer', default: 20 },
    },
    required: ['repo'],
    additionalProperties: false,
  },
};

const statusOf = async (runId: string) =>
  (await getTaskRun(APP, runId))?.status;

beforeEach(async () => {
  // Drop queued work, then let every run a previous test left open end, so
  // none holds a concurrency slot.
  await db.delete(schema.appTaskRuns);
  await until(() => {
    for (const launch of launches) if (!launch.done) launch.finish({});
    const active = (
      globalThis as { __hatchTaskRuns__?: Map<string, Map<string, unknown>> }
    ).__hatchTaskRuns__;
    return [...(active?.values() ?? [])].every((runs) => runs.size === 0);
  });
  launches.length = 0;
  await seed({ concurrency: 4, definitions: [digest] });
});

describe('App task runs', () => {
  it('records invalid input as a failed run without starting an instance', async () => {
    const result = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'nope', extra: 1 },
    });
    expect(result.status).toBe('failed');
    const run = await getTaskRun(APP, result.runId);
    expect(run?.error).toMatch(/repo: Must match the pattern/);
    expect(run?.error).toMatch(/extra/);
    expect(launches).toHaveLength(0);
  });

  it('sends defaults and a signed request, and persists steps before the result', async () => {
    const { runId } = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/b' },
    });
    await until(() => launches.length === 1);
    const launch = launches[0];
    expect(JSON.parse(launch.options.request.body)).toEqual({
      repo: 'a/b',
      limit: 20,
    });
    expect(launch.options.request.path).toBe('/app.v1.Svc/RunDigest');
    expect(launch.options.request.headers['x-hatch-run-id']).toBe(runId);
    expect(launch.options.request.headers['x-hatch-signature']).toMatch(
      /^sha256=/,
    );
    // Pinned to the deployment that validated the input, with a bounded
    // response.
    expect(launch.options.deploymentId).toBe('dep-1');
    expect(launch.options.maxResponseBytes).toBe(1024 * 1024);
    expect(launch.options.env).toEqual({
      HATCH_RUN_ID: runId,
      HATCH_TASK: 'digest',
    });
    // The step ends right before the response: it must still be recorded.
    launch.options.onStdout(
      Buffer.from(
        '[[hatch]]{"t":"step:start","seq":0,"name":"collect","attempt":1}\n' +
          'plain log line\n' +
          '[[hatch]]{"t":"step:end","seq":0,"name":"collect","attempt":1,"status":"succeeded","output":{"n":1}}',
      ),
    );
    launch.finish({
      response: { status: 200, body: '{"stars":3}', truncated: false },
    });
    await until(async () => (await statusOf(runId)) === 'succeeded');
    const run = await getTaskRun(APP, runId);
    expect(run).toMatchObject({
      output: { stars: 3 },
      version: 3,
      deploymentId: 'dep-1',
      log: 'plain log line\n',
    });
    expect(run?.steps).toMatchObject([
      { name: 'collect', status: 'succeeded', output: { n: 1 } },
    ]);
  });

  it('reports a Connect error response as the run error', async () => {
    const { runId } = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/b' },
    });
    await until(() => launches.length === 1);
    launches[0].finish({
      response: {
        status: 409,
        body: '{"code":"failed_precondition","message":"schema changed"}',
        truncated: false,
      },
    });
    await until(async () => (await statusOf(runId)) === 'failed');
    expect((await getTaskRun(APP, runId))?.error).toBe(
      'failed_precondition: schema changed',
    );
  });

  it('starts runs in order within the App and task concurrency caps', async () => {
    await seed({
      concurrency: 2,
      definitions: [digest, { ...digest, name: 'solo', concurrency: 1 }],
    });
    const solo1 = await startTaskRun(APP, 'solo', {
      trigger: 'manual',
      input: { repo: 'a/1' },
    });
    const solo2 = await startTaskRun(APP, 'solo', {
      trigger: 'manual',
      input: { repo: 'a/2' },
    });
    const third = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/3' },
    });
    const fourth = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/4' },
    });
    // solo2 waits for its task cap; the App cap admits one digest run.
    await until(() => launches.length === 2);
    await sleep(30);
    expect(launches).toHaveLength(2);
    expect(await statusOf(solo1.runId)).toBe('running');
    expect(await statusOf(solo2.runId)).toBe('queued');
    expect(await statusOf(third.runId)).toBe('running');
    expect(await statusOf(fourth.runId)).toBe('queued');
    expect((await getTaskRun(APP, solo2.runId))?.queuePosition).toBe(1);

    launches[0].finish({
      response: { status: 200, body: '{}', truncated: false },
    });
    await until(() => launches.length === 3);
    expect(await statusOf(solo2.runId)).toBe('running');
    expect(await statusOf(fourth.runId)).toBe('queued');
  });

  it('cancels a queued run and kills a running one', async () => {
    await seed({ concurrency: 1, definitions: [digest] });
    const running = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/1' },
    });
    const queued = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/2' },
    });
    await until(() => launches.length === 1);
    expect(await cancelTaskRun(APP, queued.runId)).toEqual({
      canceled: true,
      status: 'canceled',
    });
    expect(await cancelTaskRun(APP, running.runId)).toEqual({
      canceled: true,
      status: 'canceled',
    });
    await sleep(30);
    expect(await statusOf(running.runId)).toBe('canceled');
    expect(launches).toHaveLength(1);
    expect(await cancelTaskRun(APP, running.runId)).toEqual({
      canceled: false,
      status: 'canceled',
    });
  });

  it('refuses runs beyond the queue limit', async () => {
    await seed({ concurrency: 1, definitions: [digest] });
    await db.insert(schema.appTaskRuns).values(
      Array.from({ length: 100 }, (_, i) => ({
        id: `queued-${String(i).padStart(3, '0')}`,
        appId: APP,
        taskName: 'digest',
        trigger: 'manual' as const,
        status: 'queued' as const,
      })),
    );
    await expect(
      startTaskRun(APP, 'digest', {
        trigger: 'manual',
        input: { repo: 'a/b' },
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('fails queued runs once the App cannot run tasks', async () => {
    await db.update(schema.apps).set({ status: 'archived' });
    await db.insert(schema.appTaskRuns).values({
      id: 'queued-run',
      appId: APP,
      taskName: 'digest',
      trigger: 'cron',
      status: 'queued',
    });
    await recoverTaskRuns();
    await until(async () => (await statusOf('queued-run')) === 'failed');
    expect((await getTaskRun(APP, 'queued-run'))?.error).toMatch(/archived/);
    expect(launches).toHaveLength(0);
  });

  it('refuses every trigger and schedules nothing on an unsupported deployment', async () => {
    await seed({
      concurrency: 4,
      definitions: [
        {
          ...digest,
          cron: [{ name: 'daily', schedule: '0 9 * * *', input: {} }],
        },
      ],
    });
    expect(await loadTaskCronJobs()).toMatchObject([
      { ownerId: APP, jobs: [{ task: 'digest', name: 'daily' }] },
    ]);
    await db.update(schema.deployments).set({ compatibilityVersion: 99 });
    // Manual, cron, webhook and backend runs all start through startTaskRun.
    await expect(
      startTaskRun(APP, 'digest', { trigger: 'cron', input: { repo: 'a/b' } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await loadTaskCronJobs()).toEqual([{ ownerId: APP, jobs: [] }]);
    expect(launches).toHaveLength(0);
  });

  it('validates a queued run against the deployment that executes it', async () => {
    await seed({ concurrency: 1, definitions: [digest] });
    const first = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/1' },
    });
    const fits = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/2', limit: 3 },
    });
    const stale = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/3' },
    });
    await until(() => launches.length === 1);
    // A deploy while both wait: a new default and a tighter limit.
    const properties = digest.inputSchema.properties;
    await db.update(schema.deployments).set({
      manifestNormalized: {
        rpc: { url: '', service: 'app.v1.Svc' },
        tasks: {
          concurrency: 1,
          definitions: [
            {
              ...digest,
              inputSchema: {
                ...digest.inputSchema,
                properties: {
                  ...properties,
                  limit: { ...properties.limit, maximum: 5 },
                  mode: { type: 'string', default: 'fast' },
                },
              },
            },
          ],
        },
      } as never,
    });
    launches[0].finish({
      response: { status: 200, body: '{}', truncated: false },
    });
    await until(() => launches.length === 2);
    expect(JSON.parse(launches[1].options.request.body)).toEqual({
      repo: 'a/2',
      limit: 3,
      mode: 'fast',
    });
    expect((await getTaskRun(APP, fits.runId))?.input).toMatchObject({
      mode: 'fast',
    });
    launches[1].finish({
      response: { status: 200, body: '{}', truncated: false },
    });
    // Its stored limit (the old default, 20) breaks the new maximum.
    await until(async () => (await statusOf(stale.runId)) === 'failed');
    expect((await getTaskRun(APP, stale.runId))?.error).toMatch(
      /Input validation failed for version 3: limit/,
    );
    expect(launches).toHaveLength(2);
    expect(await statusOf(first.runId)).toBe('succeeded');
  });

  it('queues a run again when a deploy superseded its deployment before it started', async () => {
    const { runId } = await startTaskRun(APP, 'digest', {
      trigger: 'manual',
      input: { repo: 'a/b' },
    });
    await until(() => launches.length === 1);
    launches[0].finish({ superseded: true, error: 'deployment changed' });
    await until(() => launches.length === 2);
    expect(await statusOf(runId)).toBe('running');
    launches[1].finish({
      response: { status: 200, body: '{"ok":true', truncated: true },
    });
    await until(async () => (await statusOf(runId)) === 'succeeded');
    expect((await getTaskRun(APP, runId))?.output).toEqual({
      truncated: true,
      limitBytes: 1024 * 1024,
      preview: '{"ok":true',
    });
  });

  it('never starts a run canceled while its claim is in flight', async () => {
    // Hold the claim's response after it committed, as a slow database would.
    let claimCommitted!: () => void;
    const committed = new Promise<void>((resolve) => {
      claimCommitted = resolve;
    });
    let releaseClaim!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const realUpdate = db.update.bind(db);
    const spy = vi.spyOn(db, 'update').mockImplementation(((table: never) => {
      const builder = realUpdate(table);
      const set = builder.set.bind(builder);
      return Object.assign(builder, {
        set: (values: Record<string, unknown>) => {
          const query = set(values as never);
          if (values.status !== 'running') return query;
          const where = query.where.bind(query);
          return Object.assign(query, {
            where: (...args: Parameters<typeof where>) => {
              const filtered = where(...args);
              const returning = filtered.returning.bind(filtered);
              return Object.assign(filtered, {
                returning: (...fields: Parameters<typeof returning>) =>
                  returning(...fields).then(async (rows) => {
                    claimCommitted();
                    await gate;
                    return rows;
                  }),
              });
            },
          });
        },
      });
    }) as never);
    try {
      const { runId } = await startTaskRun(APP, 'digest', {
        trigger: 'manual',
        input: { repo: 'a/b' },
      });
      await committed;
      expect(await cancelTaskRun(APP, runId)).toEqual({
        canceled: true,
        status: 'canceled',
      });
      releaseClaim();
      await sleep(50);
      expect(launches).toHaveLength(0);
      expect(await statusOf(runId)).toBe('canceled');
    } finally {
      releaseClaim();
      spy.mockRestore();
    }
  });

  it('fails runs a previous process left running', async () => {
    await db.insert(schema.appTaskRuns).values({
      id: 'stale-run',
      appId: APP,
      taskName: 'digest',
      trigger: 'cron',
      status: 'running',
    });
    await recoverTaskRuns();
    const run = await getTaskRun(APP, 'stale-run');
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/platform restarted/);
  });
});
