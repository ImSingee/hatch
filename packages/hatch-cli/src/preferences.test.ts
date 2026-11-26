import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { PublicErrorSchema } from '../../hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { PreferenceService } from '../../hatch-platform-api/gen/hatch/platform/v1/preference_pb';
import { cliClient } from './client';
import { CliError } from './error';
import { parsePreferencesCommand } from './preferences';

const command = (...args: string[]) => parsePreferencesCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parsePreferencesCommand(args, 0);
  } catch (error) {
    return (error as { code?: string; message?: string }).message;
  }
  return 'accepted';
};

describe('preferences command arguments', () => {
  it('maps get and set to one explicit operation', () => {
    expect(command('preferences', 'get', '--json')).toEqual({ kind: 'get' });
    expect(
      command('preferences', 'set', '--agent-message-mode', 'queue'),
    ).toEqual({ kind: 'set', agentMessageMode: 'queue' });
    expect(
      command('preferences', 'set', '--agent-message-mode=steer', '--json'),
    ).toEqual({ kind: 'set', agentMessageMode: 'steer' });
    expect(
      command('preferences', 'set', '--background-app-minutes', '15'),
    ).toEqual({ kind: 'set', backgroundAppMinutes: 15 });
    expect(
      command(
        'preferences',
        'set',
        '--agent-message-mode',
        'queue',
        '--background-app-minutes=1440',
      ),
    ).toEqual({
      kind: 'set',
      agentMessageMode: 'queue',
      backgroundAppMinutes: 1440,
    });
  });

  it('rejects incomplete, unknown or misplaced input before any request', () => {
    expect(rejected('preferences')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'list')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'set')).toMatch(/--background-app-minutes/);
    for (const minutes of ['0', '1441', '1.5', '-3', '', 'ten'])
      expect(
        rejected('preferences', 'set', `--background-app-minutes=${minutes}`),
      ).toMatch(/whole number from 1 to 1440/);
    expect(
      rejected(
        'preferences',
        'set',
        '--background-app-minutes',
        '5',
        '--background-app-minutes=6',
      ),
    ).toMatch(/only once/);
    expect(
      rejected('preferences', 'set', '--agent-message-mode', 'later'),
    ).toMatch(/queue or steer/);
    expect(rejected('preferences', 'set', '--agent-message-mode', '')).toMatch(
      /queue or steer/,
    );
    expect(
      rejected('preferences', 'get', '--agent-message-mode', 'queue'),
    ).toMatch(/Invalid arguments/);
    expect(rejected('preferences', 'get', 'extra')).toMatch(/positional/);
    for (const [first, second] of [
      ['queue', 'steer'],
      ['steer', 'queue'],
    ])
      expect(
        rejected(
          'preferences',
          'set',
          '--agent-message-mode',
          first,
          `--agent-message-mode=${second}`,
        ),
      ).toMatch(/only once/);
  });

  it('says the agent preference was saved when the background time then fails', async () => {
    const update = (failure: ConnectError) =>
      cliClient(
        createRouterTransport(({ service }) => {
          service(PreferenceService, {
            getAgentPreferences: () => ({
              preferences: { messageMode: 'steer' },
            }),
            updateAgentPreferences: (request) => ({
              preferences: { messageMode: request.messageMode ?? 'steer' },
            }),
            getDeskPreferences: () => ({
              preferences: { backgroundAppMinutes: 5 },
            }),
            updateDeskPreferences: () => {
              throw failure;
            },
          });
        }),
      )
        .preferences.update({
          agentMessageMode: 'queue',
          backgroundAppMinutes: 9,
        })
        .then(
          () => {
            throw new Error('Expected the update to fail.');
          },
          (caught: unknown) => caught as CliError,
        );

    // Refused by the platform: the background time was not set.
    const refused = await update(
      new ConnectError('Out of range.', Code.InvalidArgument, undefined, [
        {
          desc: PublicErrorSchema,
          value: { code: 'BAD_REQUEST', httpStatus: 400 },
        },
      ]),
    );
    expect(refused).toBeInstanceOf(CliError);
    expect(refused.message).toMatch(
      /agentMessageMode was already set; backgroundAppMinutes was not set/,
    );
    expect(refused.details).toEqual({ applied: { agentMessageMode: 'queue' } });

    // Timed out: it may have been set, so the error does not say it was not.
    const timedOut = await update(
      new ConnectError('deadline', Code.DeadlineExceeded),
    );
    expect(timedOut.code).toBe('outcome_unknown');
    expect(timedOut.message).toMatch(
      /agentMessageMode was already set; whether backgroundAppMinutes was set is unknown/,
    );
    expect(timedOut.details).toEqual({
      applied: { agentMessageMode: 'queue' },
    });
  });
});
