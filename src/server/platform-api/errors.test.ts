/**
 * Public RPC errors carry stable codes: a domain error with a code of its
 * own reaches the CLI as that code, never as its bare HTTP status.
 */
import { describe, expect, it, vi } from 'vitest';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';

// Run credentials (and their database) play no part here.
vi.mock('~server/agent-runner/run-auth', () => ({
  RunTokenError: class RunTokenError extends Error {},
}));

const { AppError } = await import('../errors');
const { publicError } = await import('./errors');

describe('public RPC error codes', () => {
  it('reports a commit that is not on master by its own code', () => {
    const error = publicError(
      new AppError('Cannot deploy app "a": commit c is not on master.', 409, {
        code: 'deployments.commitNotOnMaster',
      }),
    );
    expect(error.findDetails(PublicErrorSchema)[0]).toMatchObject({
      code: 'COMMIT_NOT_ON_MASTER',
      httpStatus: 409,
    });
    expect(error.rawMessage).toMatch(/is not on master/);
  });

  it('keeps other conflicts generic', () => {
    expect(
      publicError(new AppError('Busy.', 409)).findDetails(PublicErrorSchema)[0]
        ?.code,
    ).toBe('CONFLICT');
  });
});
