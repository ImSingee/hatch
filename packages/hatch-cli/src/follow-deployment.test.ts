/** How a deployment follow ends: by its deadline, outcome or cancellation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentView } from './client';
import { CliError } from './error';
import { followDeployment } from './lifecycle';

type Deployments = Parameters<typeof followDeployment>[0];
type Frame = {
  lines: { seq: number; stream: string; text: string; at: string }[];
  deployment: DeploymentView | null;
};

const state = (status: string, logSeq: number) =>
  ({
    deploymentId: 'dep-1',
    status,
    finished: ['ready', 'failed', 'canceled', 'superseded'].includes(status),
    logSeq,
  }) as unknown as DeploymentView;
const line = (seq: number) => ({
  seq,
  stream: 'build',
  text: `line ${seq}`,
  at: new Date().toISOString(),
});
/** A stream that sends `frames`, then stays open until its own timeout. */
async function* stream(frames: Frame[], timeoutMs = 0) {
  for (const frame of frames) yield frame;
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  throw new CliError('outcome_unknown', 'Timed out.', 7);
}
/** Each watch call takes the next stream; get answers with `lookup`. */
function fake(
  streams: ((timeoutMs: number) => AsyncGenerator<Frame>)[],
  lookup: () => Promise<DeploymentView>,
) {
  const calls = { watch: 0, get: 0 };
  const deployments = {
    watch: (_input: unknown, options: { timeoutMs?: number }) =>
      streams[Math.min(calls.watch++, streams.length - 1)](
        options.timeoutMs ?? 0,
      ),
    get: () => {
      calls.get++;
      return lookup();
    },
  } as unknown as Deployments;
  return { deployments, calls };
}
const follow = (deployments: Deployments, budgetMs: number) =>
  followDeployment(deployments, {
    id: 'notes',
    deploymentId: 'dep-1',
    afterSeq: 0,
    deadline: Date.now() + budgetMs,
  });

describe('followDeployment', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps following a deployment the final lookup finds still running', async () => {
    const { deployments, calls } = fake(
      [
        (timeoutMs) =>
          stream(
            [{ lines: [line(1)], deployment: state('building', 1) }],
            timeoutMs,
          ),
        (timeoutMs) =>
          stream(
            [{ lines: [line(2)], deployment: state('ready', 2) }],
            timeoutMs,
          ),
      ],
      async () => state('building', 1),
    );
    await expect(follow(deployments, 2_000)).resolves.toMatchObject({
      status: 'ready',
      logSeq: 2,
    });
    expect(calls).toEqual({ watch: 2, get: 1 });
  });

  it('reports a deployment still running only once its deadline has passed', async () => {
    const { deployments } = fake(
      [(timeoutMs) => stream([], timeoutMs)],
      async () => state('building', 0),
    );
    const deadline = Date.now() + 2_000;
    const error = await followDeployment(deployments, {
      id: 'notes',
      deploymentId: 'dep-1',
      afterSeq: 0,
      deadline,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'deployment_in_progress',
      exitCode: 7,
      details: { afterSeq: 0, deployment: { status: 'building' } },
    });
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
  });

  it('keeps a known outcome when the rest of its log cannot be read', async () => {
    const unavailable = new CliError(
      'run_credentials_unavailable',
      'Renewal refused.',
      3,
    );
    // The finished state arrived, then the final lookup fails.
    const { deployments } = fake(
      [
        (timeoutMs) =>
          stream(
            [{ lines: [line(1)], deployment: state('failed', 3) }],
            timeoutMs,
          ),
      ],
      () => Promise.reject(unavailable),
    );
    await expect(follow(deployments, 2_000)).rejects.toMatchObject({
      code: 'deployment_log_incomplete',
      exitCode: 7,
      details: {
        afterSeq: 1,
        deployment: { status: 'failed' },
        cause: 'run_credentials_unavailable',
      },
    });
    // A reconnect that fails after the finished state does the same.
    const reconnect = fake(
      [
        async function* () {
          yield { lines: [line(1)], deployment: state('ready', 3) };
          throw new CliError('outcome_unknown', 'Dropped.', 7);
        },
        async function* () {
          yield* [];
          throw unavailable;
        },
      ],
      () => Promise.reject(new Error('not reached')),
    );
    await expect(follow(reconnect.deployments, 2_000)).rejects.toMatchObject({
      code: 'deployment_log_incomplete',
      details: { afterSeq: 1, deployment: { status: 'ready' } },
    });
  });

  it('reports the failure itself when no outcome is known, and a cancellation as it is', async () => {
    const unavailable = new CliError(
      'run_credentials_unavailable',
      'Renewal refused.',
      3,
    );
    const running = fake(
      [
        (timeoutMs) =>
          stream(
            [{ lines: [line(1)], deployment: state('building', 3) }],
            timeoutMs,
          ),
      ],
      () => Promise.reject(unavailable),
    );
    await expect(follow(running.deployments, 2_000)).rejects.toBe(unavailable);

    const cancelled = new CliError('cancelled', 'Cancelled.', 130);
    const interrupted = fake(
      [
        async function* () {
          yield { lines: [line(1)], deployment: state('ready', 3) };
          throw cancelled;
        },
      ],
      () => Promise.reject(new Error('not reached')),
    );
    await expect(follow(interrupted.deployments, 2_000)).rejects.toBe(
      cancelled,
    );
  });
});
