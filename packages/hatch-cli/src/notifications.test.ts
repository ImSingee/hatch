import { createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  type CreateChannelRequest,
  type CreateResponseRouteRequest,
  type ListResponseRoutesRequest,
  type CreateRouteRequest,
  type DeleteNotificationRequest,
  type RecallNotificationRequest,
  type RespondToNotificationRequest,
  type SendNotificationRequest,
  type UpdateGroupRequest,
  type UpdateNotificationRequest,
  type UpdateResponseRouteRequest,
  type UpdateRouteRequest,
} from '../../hatch-platform-api/gen/hatch/platform/v1/notification_pb';
import {
  executeNotificationCall,
  parseNotificationCommand,
} from './notifications';

const argv = (...parts: string[]) => ['notification', ...parts];
const parse = (...parts: string[]) =>
  parseNotificationCommand(argv(...parts), 0).call;

function recordingTransport() {
  const received: {
    createRoute?: CreateRouteRequest;
    updateRoute?: UpdateRouteRequest;
    createChannel?: CreateChannelRequest;
    updateGroup?: UpdateGroupRequest;
    sendNotification?: SendNotificationRequest;
    updateNotification?: UpdateNotificationRequest;
    recallNotification?: RecallNotificationRequest;
    deleteNotification?: DeleteNotificationRequest;
  } = {};
  const transport = createRouterTransport(({ service }) => {
    service(NotificationService, {
      createRoute: (request) => {
        received.createRoute = request;
        return {
          route: {
            id: 'route-1',
            sourceType: request.sourceType,
            sourceId: request.sourceId,
            kind: request.kind,
            targetType: request.targetType,
            targetId: request.targetId,
            enabled: request.enabled ?? true,
            createdAt: 'now',
            updatedAt: 'now',
          },
        };
      },
      updateRoute: (request) => {
        received.updateRoute = request;
        return {};
      },
      createChannel: (request) => {
        received.createChannel = request;
        return {
          channel: {
            id: 'channel-1',
            name: request.name,
            kinds: request.kinds?.kinds ?? [],
            enabled: true,
            pushUrl:
              'https://hatch.example/api/notifications/channel/channel-1',
            createdAt: 'now',
            updatedAt: 'now',
          },
          token: 'hnc_secret-token',
        };
      },
      updateGroup: (request) => {
        received.updateGroup = request;
        return {};
      },
      sendNotification: (request) => {
        received.sendNotification = request;
        return { notificationId: 'notification-1', deliveryCount: 0 };
      },
      updateNotification: (request) => {
        received.updateNotification = request;
        return { revision: 2, changed: true };
      },
      recallNotification: (request) => {
        received.recallNotification = request;
        return { revision: 3, changed: false };
      },
      deleteNotification: (request) => {
        received.deleteNotification = request;
        return {};
      },
    });
  });
  return { transport, received };
}

describe('notification route commands', () => {
  it('maps create flags onto CreateRoute, including a disabled rule', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'route',
        'create',
        '--source-type',
        'app',
        '--source',
        'app-1',
        '--kind',
        'order.shipped',
        '--group',
        'group-1',
        '--disabled',
      ),
    );
    expect(received.createRoute).toMatchObject({
      sourceType: 'app',
      sourceId: 'app-1',
      kind: 'order.shipped',
      targetType: 'group',
      targetId: 'group-1',
      enabled: false,
    });
    expect(result.text).toContain('app:app-1 / order.shipped');
  });

  it('requires exactly one target and no source for any-source rules', () => {
    expect(() =>
      parse(
        'route',
        'create',
        '--source-type',
        'any',
        '--group',
        'g',
        '--destination',
        'd',
      ),
    ).toThrow(/only one of --group, --destination/);
    expect(() => parse('route', 'create', '--source-type', 'any')).toThrow(
      /--group or --destination/,
    );
    expect(() =>
      parse(
        'route',
        'create',
        '--source-type',
        'any',
        '--source',
        'app-1',
        '--group',
        'g',
      ),
    ).toThrow(/--source cannot be combined/);
  });

  it('sends empty strings to clear source and kind filters on update', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('route', 'update', 'route-1', '--any-source', '--any-kind'),
    );
    // Presence of an empty value means "match any"; absence means unchanged.
    expect(received.updateRoute?.sourceId).toBe('');
    expect(received.updateRoute?.kind).toBe('');
    expect(received.updateRoute?.targetId).toBeUndefined();
    expect(received.updateRoute?.enabled).toBeUndefined();
  });
});

describe('notification channel commands', () => {
  it('parses repeatable kinds and prints the one-time token and push URL', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'channel',
        'create',
        '--name',
        'Monitoring',
        '--kind',
        'host.down:Host down',
        '--kind',
        'backup.done',
      ),
    );
    expect(received.createChannel?.kinds?.kinds).toEqual([
      expect.objectContaining({ kind: 'host.down', name: 'Host down' }),
      expect.objectContaining({ kind: 'backup.done', name: 'backup.done' }),
    ]);
    expect(result.text).toContain('Token: hnc_secret-token');
    expect(result.text).toContain(
      'https://hatch.example/api/notifications/channel/channel-1',
    );
    expect(result.json).toMatchObject({ token: 'hnc_secret-token' });
  });

  it('attaches kind descriptions to the declared kinds', () => {
    const call = parse(
      'channel',
      'update',
      'channel-1',
      '--kind',
      'host.down:Host down',
      '--kind',
      'backup.done',
      '--kind-description',
      'host.down=A monitored host stopped answering = alert',
    );
    expect(call.request.kinds).toEqual({
      kinds: [
        {
          kind: 'host.down',
          name: 'Host down',
          description: 'A monitored host stopped answering = alert',
        },
        { kind: 'backup.done', name: 'backup.done' },
      ],
    });
  });

  it('rejects descriptions that cannot apply to the replaced kind list', () => {
    // Without --kind the update would not touch kinds, so a description alone
    // must fail instead of being silently dropped.
    expect(() =>
      parse('channel', 'update', 'channel-1', '--kind-description', 'a=Text'),
    ).toThrow(/needs the full --kind list/);
    expect(() =>
      parse(
        'channel',
        'create',
        '--name',
        'X',
        '--kind',
        'a',
        '--kind-description',
        'b=Text',
      ),
    ).toThrow(/not in the --kind list/);
    expect(() =>
      parse(
        'channel',
        'create',
        '--name',
        'X',
        '--kind',
        'a',
        '--kind-description',
        'a',
      ),
    ).toThrow(/<kind>=<text>/);
  });

  it('rejects malformed kinds before calling the platform', () => {
    expect(() =>
      parse('channel', 'create', '--name', 'X', '--kind', 'Bad Kind'),
    ).toThrow(/Invalid kind/);
    expect(() => parse('channel', 'create', '--name', 'X')).toThrow(
      /at least one --kind/,
    );
  });
});

describe('notification send', () => {
  it('maps flags onto SendNotification and flags an unrouted result', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'send',
        '--channel',
        'channel-1',
        '--kind',
        'build.failed',
        '--title',
        'master is red',
        '--body',
        'Build 42 failed',
        '--url',
        'https://ci.example/42',
        '--data',
        '{"build":42}',
        '--dedupe-key',
        'build-42',
      ),
    );
    expect(received.sendNotification).toMatchObject({
      channelId: 'channel-1',
      groupId: '',
      destinationId: '',
      kind: 'build.failed',
      title: 'master is red',
      body: 'Build 42 failed',
      url: 'https://ci.example/42',
      dataJson: '{"build":42}',
      dedupeKey: 'build-42',
    });
    // Unset lets the platform default to opening the URL on phone tap.
    expect(received.sendNotification?.autoOpenUrl).toBeUndefined();
    expect(result.json).toMatchObject({
      notificationId: 'notification-1',
      deduplicated: false,
      deliveryCount: 0,
    });
    expect(result.text).toMatch(/no route matched/);
  });

  it('sends straight to a group or destination without a kind', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse('send', '--group', 'g1', '--title', 'Hi'),
    );
    expect(received.sendNotification).toMatchObject({
      channelId: '',
      groupId: 'g1',
      kind: '',
      title: 'Hi',
    });
    expect(result.text).toMatch(/group has no enabled destinations/);
    await executeNotificationCall(
      transport,
      parse('send', '--destination', 'd1', '--kind', 'ping', '--title', 'Hi'),
    );
    expect(received.sendNotification).toMatchObject({
      destinationId: 'd1',
      kind: 'ping',
    });
  });

  it('sends an explicit false to keep the notification page', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse(
        'send',
        '--destination',
        'd1',
        '--title',
        'Hi',
        '--url',
        'https://example.com',
        '--no-auto-open-url',
      ),
    );
    expect(received.sendNotification?.autoOpenUrl).toBe(false);
  });

  it('takes a priority by name or number and leaves it unset otherwise', () => {
    const priority = (...flags: string[]) =>
      parse('send', '--group', 'g1', '--title', 'Hi', ...flags).request
        .priority;
    expect(priority()).toBeUndefined();
    expect(priority('--priority', 'lowest')).toBe(-2);
    expect(priority('--priority', 'Low')).toBe(-1);
    expect(priority('--priority', 'normal')).toBe(0);
    expect(priority('--priority', 'high')).toBe(1);
    expect(priority('--priority=-2')).toBe(-2);
    expect(priority('--priority', '1')).toBe(1);
    for (const value of ['2', '-3', '0.5', 'urgent', 'emergency', ''])
      expect(() => priority(`--priority=${value}`)).toThrow(
        /Invalid --priority/,
      );
    // A bare negative reads as a flag; the error says how to write it.
    expect(() => priority('--priority', '-1')).toThrow(/--priority=-XYZ/);
  });

  it('rejects incomplete or malformed input before calling the platform', () => {
    expect(() => parse('send', '--title', 'Hi')).toThrow(
      /one of --channel, --group or --destination/,
    );
    expect(() =>
      parse('send', '--channel', 'c1', '--group', 'g1', '--title', 'Hi'),
    ).toThrow(/only one of --channel, --group, --destination/);
    // An empty id from an unset shell variable must not be ignored.
    for (const flag of ['--channel', '--group', '--destination'])
      expect(() =>
        parse('send', flag, '', '--kind', 'a', '--title', 'Hi'),
      ).toThrow(/non-empty id/);
    expect(() => parse('send', '--channel', 'c1', '--title', 'Hi')).toThrow(
      /--kind when sending to a channel/,
    );
    expect(() => parse('send', '--group', 'g1', '--kind', 'a')).toThrow(
      /--title/,
    );
    expect(() =>
      parse('send', '--group', 'g1', '--kind', 'Bad Kind', '--title', 'Hi'),
    ).toThrow(/Invalid kind/);
    expect(() =>
      parse('send', '--group', 'g1', '--title', 'Hi', '--data', '[]'),
    ).toThrow(/JSON object/);
    // The channel is a flag now, not a positional.
    expect(() =>
      parse('send', 'channel-1', '--kind', 'a', '--title', 'Hi'),
    ).toThrow(/no positional arguments/);
  });
});

describe('notification update and recall', () => {
  it('sends only the fields to change and empty values to clear', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'update',
        'notification-1',
        '--title',
        'master is green',
        '--clear-body',
        '--no-auto-open-url',
        '--clear-data',
      ),
    );
    expect(received.updateNotification).toMatchObject({
      id: 'notification-1',
      title: 'master is green',
      body: '',
      autoOpenUrl: false,
      dataJson: '',
    });
    // Unset fields keep their value on the platform.
    expect(received.updateNotification?.url).toBeUndefined();
    expect(received.updateNotification?.silent).toBe(false);
    expect(result.text).toMatch(/revision 2/);
  });

  it('rejects edits that change nothing or contradict themselves', () => {
    expect(() => parse('update', 'notification-1', '--silent')).toThrow(
      /at least one change/,
    );
    expect(() =>
      parse('update', 'notification-1', '--body', 'x', '--clear-body'),
    ).toThrow(/only one of/);
    expect(() => parse('update', 'notification-1', '--data', '[]')).toThrow(
      /JSON object/,
    );
    expect(() => parse('update', '--title', 'x')).toThrow(/<notification-id>/);
    // The notification id alone identifies it; there is no channel to name.
    expect(() => parse('recall', 'channel-1', 'notification-1')).toThrow(
      /<notification-id>/,
    );
    expect(() =>
      parse('recall', 'notification-1', '--channel', 'channel-1'),
    ).toThrow(/Invalid notification arguments/);
  });

  it('maps silent edits and repeats alerts with no content fields', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('update', 'notification-1', '--body', 'Corrected', '--silent'),
    );
    expect(received.updateNotification).toMatchObject({
      id: 'notification-1',
      body: 'Corrected',
      silent: true,
    });
    await executeNotificationCall(transport, parse('update', 'notification-1'));
    expect(received.updateNotification?.silent).toBe(false);
    expect(received.updateNotification?.body).toBeUndefined();
  });

  it('recalls by id and reports a repeated recall', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse('recall', 'notification-1'),
    );
    expect(received.recallNotification).toMatchObject({
      id: 'notification-1',
    });
    expect(result.text).toMatch(/already recalled/);
  });

  it('deletes exactly one notification by id', async () => {
    const { transport, received } = recordingTransport();
    const result = await executeNotificationCall(
      transport,
      parse('delete', 'notification-1', '--yes'),
    );
    expect(received.deleteNotification).toMatchObject({
      id: 'notification-1',
    });
    expect(result.text).toContain('notification-1');
    // Permanent deletion needs explicit consent; nothing is sent without it.
    expect(() => parse('delete', 'notification-1')).toThrow(/--yes/);
    expect(() => parse('delete', '--yes')).toThrow(/<notification-id>/);
    expect(() =>
      parse('delete', 'notification-1', 'notification-2', '--yes'),
    ).toThrow(/<notification-id>/);
  });
});

describe('notification group commands', () => {
  it('distinguishes clearing members from leaving them unchanged', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('group', 'update', 'group-1', '--clear-destinations'),
    );
    expect(received.updateGroup?.destinationIds?.ids).toEqual([]);

    await executeNotificationCall(
      transport,
      parse('group', 'update', 'group-1', '--name', 'Phones'),
    );
    expect(received.updateGroup?.destinationIds).toBeUndefined();
    expect(() =>
      parse(
        'group',
        'update',
        'group-1',
        '--destination',
        'd',
        '--clear-destinations',
      ),
    ).toThrow(/only one of/);
  });

  it('sends an explicit false to stop auto-adding devices', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('group', 'update', 'group-1', '--no-auto-add-devices'),
    );
    expect(received.updateGroup?.autoAddDevices).toBe(false);

    await executeNotificationCall(
      transport,
      parse('group', 'update', 'group-1', '--name', 'Phones'),
    );
    expect(received.updateGroup?.autoAddDevices).toBeUndefined();
  });
});

describe('notification reply commands', () => {
  function replyTransport() {
    const received: {
      sendNotification?: SendNotificationRequest;
      respondToNotification?: RespondToNotificationRequest;
      createResponseRoute?: CreateResponseRouteRequest;
      updateResponseRoute?: UpdateResponseRouteRequest;
      listResponseRoutes?: ListResponseRoutesRequest;
    } = {};
    const transport = createRouterTransport(({ service }) => {
      service(NotificationService, {
        sendNotification: (request) => {
          received.sendNotification = request;
          return { notificationId: 'notification-1', deliveryCount: 1 };
        },
        respondToNotification: (request) => {
          received.respondToNotification = request;
          return {
            response: {
              answers: request.answers,
              respondedByName: 'Ada',
              via: request.via ?? 'cli',
              respondedAt: 'now',
            },
          };
        },
        listResponseRoutes: (request) => {
          received.listResponseRoutes = request;
          return { routes: [] };
        },
        createResponseRoute: (request) => {
          received.createResponseRoute = request;
          return {
            route: {
              id: 'response-route-1',
              sourceType: request.sourceType,
              sourceId: request.sourceId,
              kind: request.kind,
              destinationId: request.destinationId,
              enabled: request.enabled ?? true,
              createdAt: 'now',
              updatedAt: 'now',
            },
          };
        },
        updateResponseRoute: (request) => {
          received.updateResponseRoute = request;
          return {};
        },
      });
    });
    return { transport, received };
  }

  it('validates --reply locally and sends the normalized form', async () => {
    const { transport, received } = replyTransport();
    await executeNotificationCall(
      transport,
      parse(
        'send',
        '--channel',
        'channel-1',
        '--kind',
        'deploy',
        '--title',
        'Deploy?',
        '--reply',
        JSON.stringify({
          fields: [
            {
              id: 'decision',
              type: 'buttons',
              label: 'Approve?',
              options: [{ id: 'yes', label: 'Yes' }],
            },
          ],
        }),
      ),
    );
    expect(received.sendNotification?.reply).toMatchObject({
      submitLabel: 'Submit',
      fields: [
        {
          id: 'decision',
          type: 'buttons',
          required: true,
          options: [{ id: 'yes', label: 'Yes', destructive: false }],
        },
      ],
    });

    const bad = parse(
      'send',
      '--channel',
      'channel-1',
      '--kind',
      'deploy',
      '--title',
      'Deploy?',
      '--reply',
      '{"fields":[{"id":"Bad","type":"text","label":"x"}]}',
    );
    await expect(executeNotificationCall(transport, bad)).rejects.toThrow(
      /^--reply: fields\.0\.id: field id must start/,
    );
    expect(() =>
      parse(
        'send',
        '--channel',
        'channel-1',
        '--kind',
        'deploy',
        '--title',
        'x',
        '--reply',
        '{}',
        '--reply-file',
        'form.json',
      ),
    ).toThrow(/only one of --reply, --reply-file/);
    expect(() =>
      parse(
        'send',
        '--channel',
        'channel-1',
        '--kind',
        'deploy',
        '--title',
        'x',
        '--reply',
        '{',
      ),
    ).toThrow('--reply must be valid JSON.');
  });

  it('maps --answer pairs, repeating a field into a list', async () => {
    const { transport, received } = replyTransport();
    const result = await executeNotificationCall(
      transport,
      parse(
        'respond',
        'notification-1',
        '--answer',
        'when=am',
        '--answer',
        'who=ada',
        '--answer',
        'who=bob',
        '--answer',
        'note=a=b',
        '--round',
        '3',
      ),
    );
    const answers = received.respondToNotification?.answers ?? {};
    expect(received.respondToNotification?.via).toBe('cli');
    expect(received.respondToNotification?.round).toBe(3);
    expect(answers.when?.answer).toEqual({ case: 'value', value: 'am' });
    expect(answers.note?.answer).toEqual({ case: 'value', value: 'a=b' });
    expect(answers.who?.answer).toMatchObject({
      case: 'optionIds',
      value: { ids: ['ada', 'bob'] },
    });
    expect(result.text).toContain('Answered notification notification-1');
  });

  it('rejects missing, mixed and malformed answers before any request', async () => {
    expect(() => parse('respond', 'n')).toThrow(/Supply --answer/);
    expect(() =>
      parse('respond', 'n', '--answer', 'a=b', '--answers', '{}'),
    ).toThrow(/either --answer or --answers/);
    expect(() => parse('respond', 'n', '--answer', 'novalue')).toThrow(
      /must be <field-id>=<value>/,
    );
    for (const round of ['0', '1.5', 'two']) {
      expect(() =>
        parse('respond', 'n', '--answer', 'a=b', '--round', round),
      ).toThrow(/--round must be a positive integer/);
    }
    const { transport, received } = replyTransport();
    await expect(
      executeNotificationCall(
        transport,
        parse('respond', 'n', '--answers', '{"a":1}'),
      ),
    ).rejects.toThrow(/answer "a" must be a string or a list/);
    expect(received.respondToNotification).toBeUndefined();
  });

  it('maps response-route flags, clearing filters with --any-*', async () => {
    const { transport, received } = replyTransport();
    await executeNotificationCall(
      transport,
      parse(
        'response-route',
        'create',
        '--source-type',
        'channel',
        '--source',
        'channel-1',
        '--kind',
        'deploy',
        '--destination',
        'webhook-1',
      ),
    );
    expect(received.createResponseRoute).toMatchObject({
      sourceType: 'channel',
      sourceId: 'channel-1',
      kind: 'deploy',
      destinationId: 'webhook-1',
    });
    await executeNotificationCall(
      transport,
      parse('response-route', 'update', 'route-1', '--any-kind', '--disable'),
    );
    expect(received.updateResponseRoute).toMatchObject({
      id: 'route-1',
      kind: '',
      enabled: false,
    });
    expect(() =>
      parse('response-route', 'create', '--source-type', 'any'),
    ).toThrow('Supply --destination <id> or --agent.');
    expect(() => parse('response-route', 'update', 'route-1')).toThrow(
      'Supply at least one response route change.',
    );
  });

  it('pages response-route list and rejects an unusable --limit', async () => {
    const { transport, received } = replyTransport();
    await executeNotificationCall(
      transport,
      parse('response-route', 'list', '--limit', '20', '--cursor', 'route-9'),
    );
    expect(received.listResponseRoutes).toMatchObject({
      limit: 20,
      cursor: 'route-9',
    });
    expect(() => parse('response-route', 'list', '--limit', '0')).toThrow(
      '--limit must be an integer between 1 and 100.',
    );
  });

  it('lists in timeline order with --order activity and rejects other orders', () => {
    expect(
      parse('list', '--order', 'activity', '--cursor', '1764000000000.X')
        .request,
    ).toMatchObject({ order: 'activity', cursor: '1764000000000.X' });
    expect(parse('list').request).toMatchObject({ order: undefined });
    expect(() => parse('list', '--order', 'updated')).toThrow(
      '--order must be created or activity.',
    );
  });
});

describe('read position commands', () => {
  it('marks through one notification or all of them, and needs exactly one', () => {
    expect(parse('mark-read', '--through', 'n-1').request).toMatchObject({
      through: { case: 'notificationId', value: 'n-1' },
    });
    expect(parse('mark-read', '--latest').request).toMatchObject({
      through: { case: 'latest', value: true },
    });
    expect(() => parse('mark-read')).toThrow(
      'Supply --through <notification-id> or --latest.',
    );
    expect(() => parse('mark-read', '--through', 'n-1', '--latest')).toThrow(
      'Use either --through <notification-id> or --latest, not both.',
    );
    expect(
      parse('mark-read', '--through', 'n-1', '--at', '2026-11-25T01:02:03.456Z')
        .request,
    ).toMatchObject({
      through: { case: 'notificationId', value: 'n-1' },
      activityAt: '2026-11-25T01:02:03.456Z',
    });
    expect(() => parse('mark-read', '--latest', '--at', '2026-11-25')).toThrow(
      '--at needs --through <notification-id>.',
    );
    expect(() =>
      parse('mark-read', '--through', 'n-1', '--at', 'yesterday'),
    ).toThrow(/--at must be an ISO 8601 time/);
    expect(parse('unread').method).toBe('getNotificationReadState');
  });
});

describe('asking a new question in an edit', () => {
  const form =
    '{"fields":[{"id":"merge","type":"buttons","label":"Merge?","options":[{"id":"merge","label":"Merge"},{"id":"hold","label":"Hold"}]}]}';

  it('sends the whole new form, or clears it, and rejects both at once', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse('update', 'notification-1', '--reply', form, '--silent'),
    );
    expect(received.updateNotification?.reply?.fields[0]).toMatchObject({
      id: 'merge',
    });
    expect(received.updateNotification?.clearReply).toBe(false);

    await executeNotificationCall(
      transport,
      parse('update', 'notification-1', '--clear-reply'),
    );
    expect(received.updateNotification).toMatchObject({ clearReply: true });
    expect(received.updateNotification?.reply).toBeUndefined();

    expect(() =>
      parse('update', 'notification-1', '--reply', form, '--clear-reply'),
    ).toThrow('Use either --reply/--reply-file or --clear-reply, not both.');
    await expect(
      executeNotificationCall(
        transport,
        parse('update', 'notification-1', '--reply', '{"fields":[]}'),
      ),
    ).rejects.toThrow(/--reply/);
  });
});

describe('cards', () => {
  it('sends a checked card, clears it, and rejects invalid or conflicting input before any request', async () => {
    const { transport, received } = recordingTransport();
    await executeNotificationCall(
      transport,
      parse(
        'update',
        'notification-1',
        '--card',
        '{"status":{"label":"CI failed","tone":"danger"},"block":{"type":"progress","label":"Checks","percent":86,"value":"12 / 14"}}',
      ),
    );
    expect(received.updateNotification?.card).toMatchObject({
      status: { label: 'CI failed', tone: 'danger' },
      block: { case: 'progress', value: { percent: 86, value: '12 / 14' } },
    });
    await executeNotificationCall(
      transport,
      parse('update', 'notification-1', '--clear-card'),
    );
    expect(received.updateNotification).toMatchObject({ clearCard: true });

    await expect(
      executeNotificationCall(
        transport,
        parse(
          'update',
          'notification-1',
          '--card',
          '{"block":{"type":"chart"}}',
        ),
      ),
    ).rejects.toThrow(/--card: block/);
    await expect(
      executeNotificationCall(
        transport,
        parse('update', 'notification-1', '--card', '{}'),
      ),
    ).rejects.toThrow('--card: give a status or a block, or use --clear-card.');
    expect(() =>
      parse('update', 'notification-1', '--card', '{}', '--clear-card'),
    ).toThrow('Use either --card/--card-file or --clear-card, not both.');
  });
});

describe('response routes to the Agent', () => {
  it('maps the agent target and rejects contradictory or orphaned options', () => {
    expect(
      parse(
        'response-route',
        'create',
        '--source-type',
        'channel',
        '--agent',
        '--agent-instructions',
        'Fix the failing check.',
      ).request,
    ).toMatchObject({
      agent: true,
      destinationId: undefined,
      agentInstructions: 'Fix the failing check.',
    });
    expect(() =>
      parse('response-route', 'create', '--source-type', 'any'),
    ).toThrow('Supply --destination <id> or --agent.');
    expect(() =>
      parse(
        'response-route',
        'create',
        '--source-type',
        'any',
        '--destination',
        'd-1',
        '--agent',
      ),
    ).toThrow('Use either --destination <id> or --agent, not both.');
    expect(() =>
      parse(
        'response-route',
        'create',
        '--source-type',
        'any',
        '--destination',
        'd-1',
        '--agent-session',
        's-1',
      ),
    ).toThrow('--agent-session and --agent-instructions need --agent.');

    expect(
      parse(
        'response-route',
        'update',
        'route-1',
        '--chat-per-notification',
        '--clear-agent-instructions',
      ).request,
    ).toMatchObject({ agentSessionId: '', agentInstructions: '' });
    expect(() =>
      parse(
        'response-route',
        'update',
        'route-1',
        '--destination',
        'd-1',
        '--agent-instructions',
        'x',
      ),
    ).toThrow(/Agent options cannot be combined with --destination/);
  });
});
