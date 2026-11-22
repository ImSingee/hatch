import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const { listLatestWorkflowRuns, listRecentWorkflowRuns } =
  await import('./manage');

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 0, minutes));

beforeEach(async () => {
  await db.delete(schema.workflowRuns);
  await db.delete(schema.workflows);
  await db.insert(schema.workflows).values([
    { id: 'wf-busy', slug: 'busy', name: 'Busy' },
    { id: 'wf-rare', slug: 'rare', name: 'Rare' },
    { id: 'wf-new', slug: 'new', name: 'Never run' },
  ]);
});

describe('latest run per workflow', () => {
  it('keeps a rarely run workflow behind many newer runs of another', async () => {
    await db.insert(schema.workflowRuns).values({
      workflowId: 'wf-rare',
      trigger: 'manual',
      status: 'succeeded',
      createdAt: at(0),
      startedAt: at(0),
    });
    await db.insert(schema.workflowRuns).values(
      Array.from({ length: 120 }, (_, index) => ({
        workflowId: 'wf-busy',
        trigger: 'cron' as const,
        status: index === 119 ? ('failed' as const) : ('succeeded' as const),
        createdAt: at(10 + index),
      })),
    );

    // The recent executions list is cut at 100, so the rare run is not in it.
    const recent = await listRecentWorkflowRuns();
    expect(recent.some((run) => run.workflowId === 'wf-rare')).toBe(false);

    const latest = await listLatestWorkflowRuns();
    expect(
      latest
        .map(({ workflowId, status, createdAt }) => ({
          workflowId,
          status,
          createdAt,
        }))
        .sort((left, right) => left.workflowId.localeCompare(right.workflowId)),
    ).toEqual([
      {
        workflowId: 'wf-busy',
        status: 'failed',
        createdAt: at(129).toISOString(),
      },
      {
        workflowId: 'wf-rare',
        status: 'succeeded',
        createdAt: at(0).toISOString(),
      },
    ]);
  });
});
