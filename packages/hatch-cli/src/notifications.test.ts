import { createRouterTransport } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import {
  NotificationService,
  type CreateChannelRequest,
  type CreateRouteRequest,
  type DeleteNotificationRequest,
  type RecallNotificationRequest,
  type SendNotificationRequest,
  type UpdateGroupRequest,
  type UpdateNotificationRequest,
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
    expect(result.text).toMatch(/revision 2/);
  });

  it('rejects edits that change nothing or contradict themselves', () => {
    expect(() => parse('update', 'notification-1')).toThrow(
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
