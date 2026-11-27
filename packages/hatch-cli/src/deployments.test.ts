/** `hatch app deployments` validates its arguments before any request. */
import { describe, expect, it } from 'vitest';
import { parseDeploymentsCommand } from './deployments';

const parse = (...args: string[]) =>
  parseDeploymentsCommand(['app', 'deployments', ...args], 0);

describe('app deployments arguments', () => {
  it('maps each action and its flags', () => {
    expect(
      parse('list', 'notes', '--limit', '5', '--cursor', '12'),
    ).toMatchObject({ action: 'list', id: 'notes', limit: 5, cursor: 12 });
    expect(
      parse('logs', 'notes', 'dep-1', '--after', '40', '--follow'),
    ).toMatchObject({
      action: 'logs',
      deploymentId: 'dep-1',
      after: 40,
      follow: true,
      // Following waits for the build, so its default budget is long.
      timeoutMs: 1_800_000,
    });
    // The queue spans every App: no App argument, a deployment id cursor.
    expect(
      parse('queue', '--limit', '10', '--cursor', '01m8d5gqrf6qyexjz215hy4gbz'),
    ).toMatchObject({
      action: 'queue',
      id: undefined,
      limit: 10,
      cursor: '01m8d5gqrf6qyexjz215hy4gbz',
    });
    expect(parse('cancel', 'notes', 'dep-1', '--yes')).toMatchObject({
      action: 'cancel',
      deploymentId: 'dep-1',
      timeoutMs: 30_000,
    });
  });

  it.each([
    [['remove', 'notes', 'dep-1'], /list, queue, get, logs or cancel/],
    [['queue', 'notes'], /no positional arguments/],
    [['queue', '--cursor', '12'], /--cursor must be the nextCursor/],
    [['queue', '--after', '3'], /--after applies only/],
    // Cancel cannot be undone: it needs --yes, and only it takes --yes.
    [['cancel', 'notes', 'dep-1'], /pass --yes/],
    [['get', 'notes', 'dep-1', '--yes'], /--yes applies only/],
    [['get', 'notes'], /deployment ID/],
    [['list', 'notes', 'dep-1'], /exactly one App/],
    [['list', 'notes', '--limit', '0'], /--limit/],
    [['list', 'notes', '--cursor', 'abc'], /--cursor/],
    [['get', 'notes', 'dep-1', '--follow'], /--follow applies only/],
    [['logs', 'notes', 'dep-1', '--limit', '5'], /--limit applies only/],
    [['logs', 'notes', 'dep-1', '--after', '-1'], /--after|is not a flag/],
    [['logs', 'notes', 'dep-1', '--timeout', '0'], /--timeout/],
  ])('rejects %j', (args, message) => {
    expect(() => parse(...args)).toThrow(message);
  });
});
