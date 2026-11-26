import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';
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
    expect(command('preferences', 'set', '--language', 'zh-CN')).toStrictEqual({
      kind: 'set',
      language: 'zh-CN',
    });
    expect(
      command(
        'preferences',
        'set',
        '--language=en',
        '--agent-message-mode',
        'queue',
      ),
    ).toStrictEqual({ kind: 'set', agentMessageMode: 'queue', language: 'en' });
  });

  it('rejects incomplete, unknown or misplaced input before any request', () => {
    expect(rejected('preferences')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'list')).toMatch(/preferences get or/);
    expect(rejected('preferences', 'set')).toMatch(
      /--agent-message-mode .*--background-app-minutes .*--language/,
    );
    for (const language of ['fr', 'zh', 'ZH-cn', ''])
      expect(rejected('preferences', 'set', '--language', language)).toMatch(
        /--language must be en or zh-CN/,
      );
    expect(
      rejected('preferences', 'set', '--language', 'en', '--language=zh-CN'),
    ).toMatch(/--language only once/);
    expect(rejected('preferences', 'get', '--language', 'en')).toMatch(
      /Invalid arguments/,
    );
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

  it('stops at the first failed preference and names what was saved and skipped', async () => {
    const updateLanguage = vi.fn<() => { preferences: { language: string } }>(
      () => ({
        preferences: { language: 'zh-CN' },
      }),
    );
    const failed = await cliClient(
      createRouterTransport(({ service }) => {
        service(PreferenceService, {
          updateAgentPreferences: () => ({
            preferences: { messageMode: 'queue' },
          }),
          updateDeskPreferences: () => {
            throw new ConnectError(
              'Out of range.',
              Code.InvalidArgument,
              undefined,
              [
                {
                  desc: PublicErrorSchema,
                  value: { code: 'BAD_REQUEST', httpStatus: 400 },
                },
              ],
            );
          },
          updateInterfacePreferences: updateLanguage,
        });
      }),
    )
      .preferences.update({
        agentMessageMode: 'queue',
        backgroundAppMinutes: 9,
        language: 'zh-CN',
      })
      .then(
        () => {
          throw new Error('Expected the update to fail.');
        },
        (caught: unknown) => caught as CliError,
      );
    expect(failed.message).toMatch(
      /agentMessageMode was already set; backgroundAppMinutes was not set\. language was not attempted\./,
    );
    expect(failed.details).toEqual({ applied: { agentMessageMode: 'queue' } });
    expect(updateLanguage).not.toHaveBeenCalled();
  });
});
