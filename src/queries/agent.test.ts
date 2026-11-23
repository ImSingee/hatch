import { describe, expect, it, vi } from 'vitest';

vi.mock('~server/agent-runner-status', () => ({
  getAgentRunnerStatusFn: vi.fn<() => unknown>(),
}));
vi.mock('~server/providers', () => ({ listProviders: vi.fn<() => unknown>() }));
vi.mock('~server/agent-sessions', () => ({
  getSession: vi.fn<() => unknown>(),
  listSessions: vi.fn<() => unknown>(),
}));

const { sessionQueryOptions } = await import('./agent');

type Snapshot = {
  activeRun: object | null;
  retry: { nextRetryAt: string | null } | null;
  pending: { paused: boolean; messages: object[] };
  clockOffsetMs: number;
};

function interval(snapshot: Snapshot) {
  const refetch = sessionQueryOptions('s1').refetchInterval as (query: {
    state: { data: Snapshot };
  }) => number | false;
  return refetch({ state: { data: snapshot } });
}

const idle: Snapshot = {
  activeRun: null,
  retry: null,
  pending: { paused: false, messages: [] },
  clockOffsetMs: 0,
};

describe('session re-reads while the platform starts runs on its own', () => {
  it('follows a scheduled retry and waiting messages, not a paused or busy session', () => {
    const due = new Date(Date.now() - 1000).toISOString();
    const waiting = { paused: false, messages: [{}] };
    expect(interval(idle)).toBe(false);
    expect(interval({ ...idle, pending: waiting })).toBe(1500);
    expect(
      interval({ ...idle, pending: { paused: true, messages: [{}] } }),
    ).toBe(false);
    // A due retry keeps its own schedule even while messages wait.
    expect(
      interval({ ...idle, retry: { nextRetryAt: due }, pending: waiting }),
    ).toBe(1000);
    expect(
      interval({ ...idle, activeRun: {}, retry: { nextRetryAt: due } }),
    ).toBe(false);
  });
});
