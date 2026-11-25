/**
 * Reply forms end to end: senders attach a form, one person answers it (from
 * the web, the CLI/RPC or a push signed by the phone), phones are told it was
 * answered, and response routes deliver the answer.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { summaryFromTitle } from '../../../packages/hatch-platform-api/notification-content';
import { legacyToContent } from '../../../packages/hatch-platform-api/notification-content-legacy';
import {
  compileCard,
  compileMarkdown,
} from '../../../packages/hatch-platform-api/notification-content-schema';
import { contentToPlainText } from '../../../packages/hatch-platform-api/notification-content-text';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~server/apps/runtime', () => ({
  callAppBackend: vi.fn<typeof import('~server/apps/runtime').callAppBackend>(),
}));

vi.stubEnv('APP_URL', 'https://hatch.example.test');
vi.stubEnv('SECRET', 'platform-secret');
// pruneHistory also sweeps agent attachments under the workspace root.
vi.stubEnv(
  'HATCH_DATA_DIR',
  mkdtempSync(path.join(os.tmpdir(), 'hatch-replies-test-')),
);

const { db, schema } = await import('~/db');
const { callAppBackend } = await import('~server/apps/runtime');
const { verifyHatchSignature } = await import('~server/secrets');
const service = await import('./service');
const { handleChannelPush } = await import('./channel-ingress');
const {
  claimDueDeliveries,
  claimFairly,
  planDelivery,
  runClaimedDelivery,
  runClaimedResponseDelivery,
} = await import('./dispatcher');
const { deliverToWebhook } = await import('./adapters/webhook');
const { deliverToApp } = await import('./adapters/app');
const { pushPlaintext } = await import('./adapters/device');
const { recallNotification, updateNotification } = await import('./lifecycle');
const { notificationUpdateSchema } = await import('./contract');
const { applyLifecycleRequest } = await import('./lifecycle-http');
const { pruneHistory } = await import('~server/retention');
const { syncAppNotificationDestination } = await import('./app-destinations');
const {
  AlreadyRespondedError,
  deviceResponseSignature,
  handleDeviceResponse,
  respondToNotification,
} = await import('./responses');
type DeliveryContext = import('./delivery').DeliveryContext;

const DEVICE_KEY = Buffer.alloc(32, 7);
const KEY_ID = 'reply-device-key';

const deviceCalls: DeliveryContext[] = [];
const adapters = {
  webhook: deliverToWebhook,
  app: deliverToApp,
  device: vi.fn<import('./delivery').DeliveryAdapter>(async (context) => {
    deviceCalls.push(context);
    return { kind: 'success' };
  }),
};

async function runAll() {
  for (const claimed of await claimDueDeliveries(20)) {
    await runClaimedDelivery(claimed, adapters);
  }
  for (const claimed of await claimDueDeliveries(20, 'response')) {
    await runClaimedResponseDelivery(claimed, adapters);
  }
}

type Received = { headers: http.IncomingHttpHeaders; body: string };
const received: Received[] = [];
let webhookStatus = 200;
const server = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    received.push({ headers: request.headers, body });
    response.statusCode = webhookStatus;
    response.end('ok');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/answers`;

afterAll(() => {
  server.close();
});

const APPROVE_FORM = {
  fields: [
    {
      id: 'decision',
      type: 'buttons',
      label: 'Approve the deploy?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', destructive: true },
      ],
    },
  ],
};

let channelId = '';
let channelToken = '';
let deviceId = '';
let webhookId = '';
let webhookSecret = '';

async function pushAsChannel(body: Record<string, unknown>) {
  return handleChannelPush(
    new Request(
      `https://hatch.example.test/api/notifications/channel/${channelId}`,
      {
        method: 'POST',
        headers: { 'x-hatch-secret': channelToken },
        body: JSON.stringify(body),
      },
    ),
    channelId,
  );
}

async function sendForm(reply: unknown = APPROVE_FORM, kind = 'deploy') {
  const response = await pushAsChannel({ kind, title: 'Deploy?', reply });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as { id: string };
  await runAll();
  return id;
}

function deviceRequest(
  body: unknown,
  options: { key?: Buffer; at?: number } = {},
) {
  const text = JSON.stringify(body);
  const timestamp = String(options.at ?? Date.now());
  return new Request(
    'https://hatch.example.test/api/notifications/device-response',
    {
      method: 'POST',
      headers: {
        'x-hatch-kid': KEY_ID,
        'x-hatch-timestamp': timestamp,
        'x-hatch-signature': deviceResponseSignature(
          options.key ?? DEVICE_KEY,
          timestamp,
          text,
        ),
      },
      body: text,
    },
  );
}

beforeEach(async () => {
  received.length = 0;
  deviceCalls.length = 0;
  webhookStatus = 200;
  vi.mocked(callAppBackend).mockReset();
  await db.delete(schema.notifications);
  await db.delete(schema.notificationResponseRoutes);
  await db.delete(schema.notificationRoutes);
  await db.delete(schema.notificationDestinations);
  await db.delete(schema.notificationChannels);
  await db.delete(schema.apps);
  await db.delete(schema.session);
  await db.delete(schema.user);

  await db.insert(schema.user).values([
    { id: 'user-1', name: 'Ada', email: 'ada@example.test' },
    { id: 'user-2', name: 'Bob', email: 'bob@example.test' },
  ]);
  await db.insert(schema.session).values({
    id: 'session-1',
    token: 'session-token',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 3600_000),
    updatedAt: new Date(),
  });
  const created = await service.createChannel({
    name: 'CI',
    kinds: [
      { kind: 'deploy', name: 'Deploy' },
      { kind: 'survey', name: 'Survey' },
    ],
  });
  channelId = created.channel.id;
  channelToken = created.token;
  const device = await service.registerDevice({
    sessionId: 'session-1',
    userId: 'user-1',
    name: 'iPhone',
    platform: 'ios',
    apnsToken: 'ab'.repeat(32),
    apnsEnvironment: 'sandbox',
    e2eKeyId: KEY_ID,
    e2eKey: DEVICE_KEY.toString('base64url'),
  });
  deviceId = device.id;
  const webhook = await service.createWebhook({
    name: 'Plain hook',
    url: webhookUrl,
  });
  webhookId = webhook.destination.id;
  webhookSecret = webhook.secret;
  // Notifications reach the phone and a webhook that takes no lifecycle events.
  await service.createRoute({
    sourceType: 'any',
    targetType: 'destination',
    targetId: deviceId,
  });
  await service.createRoute({
    sourceType: 'any',
    targetType: 'destination',
    targetId: webhookId,
  });
});

describe('sending a reply form', () => {
  it('rejects an invalid form and names the field to fix', async () => {
    const response = await pushAsChannel({
      kind: 'deploy',
      title: 'Deploy?',
      reply: {
        fields: [
          {
            id: 'decision',
            type: 'buttons',
            label: 'Pick',
            options: [1, 2, 3, 4, 5].map((n) => ({
              id: `o${n}`,
              label: `O${n}`,
            })),
          },
        ],
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      'reply.fields.0.options: buttons fields need 1-4 options',
    );
  });

  it('stores the normalized form, keeps the tap on the form and shows buttons on the phone', async () => {
    const id = await sendForm({ ...APPROVE_FORM, submitLabel: '' });
    const detail = await service.getNotification(id);
    expect(detail.reply).toEqual({
      submitLabel: 'Submit',
      fields: [
        {
          id: 'decision',
          type: 'buttons',
          label: 'Approve the deploy?',
          required: true,
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'reject', label: 'Reject', destructive: true },
          ],
        },
      ],
    });
    expect(detail.autoOpenUrl).toBe(false);
    const [first] = deviceCalls;
    expect(
      pushPlaintext(
        first!.notification,
        first!.event,
        'https://o',
        first!.response,
      ).q,
    ).toEqual({
      m: 'b',
      f: 'decision',
      a: [
        { i: 'approve', l: 'Approve' },
        { i: 'reject', l: 'Reject', d: 1 },
      ],
    });
    const envelope = JSON.parse(received[0]!.body);
    expect(envelope.notification.reply.fields[0].id).toBe('decision');
    expect(envelope.notification.response).toBeNull();
  });
});

describe('answering', () => {
  it('records one answer, updates the phone in place and delivers the answer to response routes only', async () => {
    await service.createResponseRoute({
      sourceType: 'channel',
      sourceId: channelId,
      kind: 'deploy',
      target: { destinationId: webhookId },
    });
    const id = await sendForm();
    received.length = 0;
    deviceCalls.length = 0;

    const answered = await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-2', via: 'web' },
    );
    expect(answered).toMatchObject({
      answers: { decision: 'approve' },
      respondedBy: { userId: 'user-2', name: 'Bob' },
      via: 'web',
    });
    await runAll();

    // The phone gets the answered state as a passive update.
    expect(deviceCalls).toHaveLength(1);
    const update = deviceCalls[0]!;
    expect(update.event).toBe('updated');
    expect(update.silent).toBe(true);
    expect(
      pushPlaintext(
        update.notification,
        update.event,
        'https://o',
        update.response,
        update.silent,
      ).q,
    ).toEqual({ m: 'x', s: 'Answered by Bob: Approve' });
    expect(
      pushPlaintext(
        update.notification,
        update.event,
        'https://o',
        update.response,
        update.silent,
      ),
    ).not.toHaveProperty('a');

    // The webhook takes no lifecycle events: only the response route's
    // delivery of the answer reaches it.
    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    expect(delivery.headers['x-hatch-event']).toBe(
      'hatch.notification.responded',
    );
    expect(
      verifyHatchSignature({
        secret: webhookSecret,
        timestamp: String(delivery.headers['x-hatch-timestamp']),
        signature: String(delivery.headers['x-hatch-signature']),
        payload: delivery.body,
      }),
    ).toBe(true);
    const envelope = JSON.parse(delivery.body);
    expect(envelope.type).toBe('hatch.notification.responded');
    expect(envelope.notification.response).toMatchObject({
      answers: { decision: 'approve' },
      respondedBy: { userId: 'user-2', name: 'Bob' },
      via: 'web',
    });

    const detail = await service.getNotification(id);
    expect(detail.respondedAt).not.toBeNull();
    expect(detail.response?.answers).toEqual({ decision: 'approve' });
    expect(detail.responseDeliveryList).toMatchObject([
      { destinationId: webhookId, status: 'succeeded' },
    ]);
    const awaiting = await service.listNotifications({
      replyState: 'awaiting',
    });
    expect(awaiting.items).toHaveLength(0);
    const done = await service.listNotifications({ replyState: 'answered' });
    expect(done.items.map((item) => item.id)).toEqual([id]);
  });

  it('accepts only the first of concurrent answers', async () => {
    const id = await sendForm();
    const results = await Promise.allSettled([
      respondToNotification(
        id,
        { decision: 'approve' },
        { userId: 'user-1', via: 'web' },
      ),
      respondToNotification(
        id,
        { decision: 'reject' },
        { userId: 'user-2', via: 'cli' },
      ),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = rejected[0]!.reason;
    expect(error).toBeInstanceOf(AlreadyRespondedError);
    expect(error.status).toBe(409);
    const winner = (
      fulfilled[0] as PromiseFulfilledResult<{ answers: unknown }>
    ).value;
    expect(error.response.answers).toEqual(winner.answers);
    const rows = await db.query.notificationResponses.findMany({
      where: { notificationId: id },
    });
    expect(rows).toHaveLength(1);
  });

  it('rejects answers that do not fit the form, and answers after a recall', async () => {
    const id = await sendForm(
      {
        fields: [
          {
            id: 'slots',
            type: 'multiple',
            label: 'Which slots?',
            options: [
              { id: 'am', label: 'Morning' },
              { id: 'pm', label: 'Afternoon' },
              { id: 'eve', label: 'Evening' },
            ],
            maxSelected: 2,
          },
          { id: 'note', type: 'text', label: 'Note', required: false },
        ],
      },
      'survey',
    );
    const answer = (answers: unknown) =>
      respondToNotification(id, answers, { userId: 'user-1', via: 'web' });
    await expect(answer({ slots: ['am', 'pm', 'eve'] })).rejects.toMatchObject({
      status: 400,
      message: 'answers.slots: select 1-2 options',
    });
    await expect(answer({ slots: ['night'] })).rejects.toMatchObject({
      status: 400,
      message: 'answers.slots: unknown option "night"',
    });
    await expect(answer({ note: 'hi' })).rejects.toMatchObject({
      status: 400,
      message: 'answers.slots: is required',
    });
    await expect(answer({ slots: ['am'], extra: 'x' })).rejects.toMatchObject({
      status: 400,
      message: 'answers.extra: unknown field',
    });

    await recallNotification({ type: 'channel', channelId }, id);
    await expect(answer({ slots: ['am'] })).rejects.toMatchObject({
      status: 409,
      message: 'This notification was recalled.',
    });
  });

  it('rejects answers to a notification without a form', async () => {
    const response = await pushAsChannel({ kind: 'deploy', title: 'FYI' });
    const { id } = (await response.json()) as { id: string };
    await expect(
      respondToNotification(id, {}, { userId: 'user-1', via: 'web' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('direct notifications from a member', () => {
  it('take answers but are never sent along response routes', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const sent = await service.sendNotification({
      to: { type: 'destination', id: deviceId },
      sender: { type: 'user', userId: 'user-2', name: 'Bob' },
      body: { title: 'Lunch?', reply: APPROVE_FORM },
    });
    await runAll();
    await expect(
      service.sendNotification({
        to: { type: 'destination', id: deviceId },
        sender: { type: 'user', userId: 'user-2', name: 'Bob' },
        body: { title: 'Bad', reply: { fields: [] } },
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'reply.fields: a reply form needs at least one field.',
    });
    received.length = 0;
    await respondToNotification(
      sent.id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    await runAll();
    const detail = await service.getNotification(sent.id);
    expect(detail.response?.answers).toEqual({ decision: 'approve' });
    expect(detail.responseDeliveryList).toEqual([]);
    expect(received).toHaveLength(0);
  });
});

describe('answers and edit events', () => {
  it('never tell webhooks or Apps about an answer as an edit', () => {
    const webhook = { type: 'webhook' as const, lifecycleEvents: true };
    const answered = { revision: 2, recalledAt: null, responseRevision: 2 };
    expect(planDelivery(1, answered, webhook)).toEqual({ kind: 'skipped' });
    expect(
      planDelivery(1, answered, { type: 'device', lifecycleEvents: false }),
    ).toEqual({ kind: 'send', event: 'updated' });
    // An edit after the answer is still a change to send.
    expect(planDelivery(1, { ...answered, revision: 3 }, webhook)).toEqual({
      kind: 'send',
      event: 'updated',
    });
  });

  it('lets a delivery re-queued by an answer finish without sending again', async () => {
    await service.updateDestination({ id: webhookId, lifecycleEvents: true });
    const id = await sendForm();
    received.length = 0;
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    // As if the webhook delivery was in flight and re-queued itself.
    await db
      .update(schema.notificationDeliveries)
      .set({ status: 'pending', nextAttemptAt: new Date() })
      .where(eq(schema.notificationDeliveries.destinationId, webhookId));
    await runAll();
    expect(received).toHaveLength(0);
    const delivery = (await service.getNotification(id)).deliveryList.find(
      (entry) => entry.destinationId === webhookId,
    );
    expect(delivery).toMatchObject({
      status: 'succeeded',
      deliveredRevision: 2,
    });
  });
});

describe('answer events', () => {
  it('keep the revision the answer created, even after a later edit', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const id = await sendForm();
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    await updateNotification(
      { type: 'channel', channelId },
      { id, title: 'Deploy v2.5?' },
    );
    received.length = 0;
    await runAll();
    const envelope = JSON.parse(
      received.find(
        (entry) =>
          entry.headers['x-hatch-event'] === 'hatch.notification.responded',
      )!.body,
    );
    expect(envelope.revision).toBe(2);
    expect(envelope.notification.revision).toBe(3);
    expect(envelope.notification.title).toBe('Deploy v2.5?');
  });

  it('never share a revision with notification events', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const events = async (body: Record<string, unknown>, edit: boolean) => {
      // Answered (and maybe edited) before anything was delivered.
      const pushed = await pushAsChannel({
        kind: 'deploy',
        title: 'Deploy?',
        ...body,
      });
      const { id } = (await pushed.json()) as { id: string };
      if (edit) {
        await updateNotification(
          { type: 'channel', channelId },
          { id, title: 'Deploy v2.5?' },
        );
      }
      await respondToNotification(
        id,
        { decision: 'approve' },
        { userId: 'user-1', via: 'web' },
      );
      received.length = 0;
      await runAll();
      return received
        .map((entry) => JSON.parse(entry.body))
        .map((event) => [
          event.type,
          event.revision,
          event.notification.revision,
        ]);
    };
    expect(await events({ reply: APPROVE_FORM }, false)).toEqual([
      ['hatch.notification', 1, 1],
      ['hatch.notification.responded', 2, 1],
    ]);
    expect(await events({ reply: APPROVE_FORM }, true)).toEqual([
      ['hatch.notification', 2, 2],
      ['hatch.notification.responded', 3, 2],
    ]);
  });

  it('survive history retention until they are delivered', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const id = await sendForm();
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    // Old enough to prune, with every notification delivery finished.
    await db
      .update(schema.notifications)
      .set({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60_000) })
      .where(eq(schema.notifications.id, id));
    await db
      .update(schema.notificationDeliveries)
      .set({ status: 'succeeded' })
      .where(eq(schema.notificationDeliveries.notificationId, id));
    await pruneHistory();
    expect(
      await db.query.notifications.findFirst({ where: { id } }),
    ).toBeDefined();

    await runAll();
    await pruneHistory();
    expect(
      await db.query.notifications.findFirst({ where: { id } }),
    ).toBeUndefined();
  });
});

describe('dispatching answers under load', () => {
  it('claims answer deliveries even while notifications are backed up', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const answered = await sendForm();
    await respondToNotification(
      answered,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    // A backlog of ordinary deliveries, all due before the answer.
    for (let i = 0; i < 10; i += 1) {
      await pushAsChannel({ kind: 'deploy', title: `Backlog ${i}` });
    }
    await db
      .update(schema.notificationDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.notificationDeliveries.status, 'pending'));

    const queues = async (limit: number, responsesFirst: boolean) =>
      (await claimFairly(limit, responsesFirst)).map((entry) => entry.queue);
    // One free slot: the queue whose turn it is gets it.
    expect(await queues(1, false)).toEqual(['notification']);
    expect(await queues(1, true)).toEqual(['response']);
  });

  it('fills spare slots from either queue', async () => {
    for (let i = 0; i < 3; i += 1) {
      await pushAsChannel({ kind: 'deploy', title: `Only ${i}` });
    }
    // Nothing waits in the answer queue, so notifications take every slot.
    const claimed = await claimFairly(8, true);
    expect(claimed.every((entry) => entry.queue === 'notification')).toBe(true);
    expect(claimed).toHaveLength(6);
  });
});

describe('answered notifications', () => {
  it('keep the data their answer was given for', async () => {
    const pushed = await pushAsChannel({
      kind: 'deploy',
      title: 'Deploy?',
      data: { deployId: 'A', environment: 'production' },
      reply: APPROVE_FORM,
    });
    const { id } = (await pushed.json()) as { id: string };
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    const sender = { type: 'channel' as const, channelId };
    await expect(
      updateNotification(sender, { id, data: { deployId: 'B' } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateNotification(sender, { id, data: null }),
    ).rejects.toMatchObject({ status: 409 });
    // Other content may still change, and repeating the same data is fine.
    await expect(
      // The same data with its keys in another order (jsonb reorders them).
      updateNotification(sender, {
        id,
        title: 'Deployed',
        data: { environment: 'production', deployId: 'A' },
      }),
    ).resolves.toMatchObject({ changed: true });
  });

  it('let response route edits keep a concurrent disable', async () => {
    const route = await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    await Promise.all([
      service.updateResponseRoute({ id: route.id, enabled: false }),
      service.updateResponseRoute({ id: route.id, name: 'Renamed' }),
    ]);
    const {
      routes: [stored],
    } = await service.listResponseRoutes();
    expect(stored).toMatchObject({ name: 'Renamed', enabled: false });
  });

  it('pages response routes in id order until no cursor remains', async () => {
    const created = [];
    for (const name of ['One', 'Two', 'Three'])
      created.push(
        await service.createResponseRoute({
          name,
          sourceType: 'any',
          target: { destinationId: webhookId },
        }),
      );
    // ULIDs created in the same millisecond have random suffixes.
    const ordered = [...created].sort((a, b) => a.id.localeCompare(b.id));
    const first = await service.listResponseRoutes({ limit: 2 });
    expect(first.routes.map((route) => route.name)).toEqual(
      ordered.slice(0, 2).map((route) => route.name),
    );
    expect(first.nextCursor).toBe(ordered[1]!.id);
    const second = await service.listResponseRoutes({
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({
      routes: [{ name: ordered[2]!.name }],
      nextCursor: null,
    });
  });
});

describe('answers outside response routes', () => {
  it('never ride along with notification deliveries to webhooks', async () => {
    await service.updateDestination({ id: webhookId, lifecycleEvents: true });
    const id = await sendForm();
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    await updateNotification(
      { type: 'channel', channelId },
      { id, title: 'Deploy v2.5?' },
    );
    received.length = 0;
    await runAll();
    const events = received.map((entry) => JSON.parse(entry.body));
    expect(events.map((event) => event.type)).toEqual([
      'hatch.notification.updated',
    ]);
    expect(events[0].notification.response).toBeNull();
    // The phone still learns who answered.
    const update = deviceCalls.at(-1)!;
    expect(update.response?.answers).toEqual({ decision: 'approve' });
  });
});

describe('answers signed by a phone', () => {
  it('records the answer as the device owner, for notifications the device received', async () => {
    const id = await sendForm();
    const response = await handleDeviceResponse(
      deviceRequest({ notificationId: id, answers: { decision: 'reject' } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      response: Record<string, unknown>;
    };
    expect(body.response).toMatchObject({
      answers: { decision: 'reject' },
      respondedBy: { userId: 'user-1', name: 'Ada' },
      via: 'push',
      destinationId: deviceId,
    });

    const again = await handleDeviceResponse(
      deviceRequest({ notificationId: id, answers: { decision: 'approve' } }),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      ok: false,
      error: { code: 'ALREADY_RESPONDED' },
      response: { answers: { decision: 'reject' } },
    });
  });

  it('rejects forged, stale and out-of-scope answers', async () => {
    const id = await sendForm();
    const forged = await handleDeviceResponse(
      deviceRequest(
        { notificationId: id, answers: { decision: 'approve' } },
        { key: Buffer.alloc(32, 1) },
      ),
    );
    expect(forged.status).toBe(401);

    const stale = await handleDeviceResponse(
      deviceRequest(
        { notificationId: id, answers: { decision: 'approve' } },
        { at: Date.now() - 10 * 60_000 },
      ),
    );
    expect(stale.status).toBe(401);

    // A notification that never reached this device looks missing.
    await db
      .delete(schema.notificationDeliveries)
      .where(eq(schema.notificationDeliveries.destinationId, deviceId));
    const unseen = await handleDeviceResponse(
      deviceRequest({ notificationId: id, answers: { decision: 'approve' } }),
    );
    expect(unseen.status).toBe(404);

    const other = await sendForm();
    await service.updateDestination({ id: deviceId, enabled: false });
    const disabled = await handleDeviceResponse(
      deviceRequest({
        notificationId: other,
        answers: { decision: 'approve' },
      }),
    );
    expect(disabled.status).toBe(403);
    expect(await db.query.notificationResponses.findMany()).toHaveLength(0);
  });

  it('rejects answers once the device session has expired', async () => {
    const id = await sendForm();
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.session.id, 'session-1'));
    const response = await handleDeviceResponse(
      deviceRequest({ notificationId: id, answers: { decision: 'approve' } }),
    );
    expect(response.status).toBe(403);
    expect(await db.query.notificationResponses.findMany()).toHaveLength(0);
  });

  it('stops reading a body over the limit, even without a length', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(new Uint8Array(4096));
      },
    });
    const response = await handleDeviceResponse(
      new Request(
        'https://hatch.example.test/api/notifications/device-response',
        { method: 'POST', body, duplex: 'half' } as RequestInit,
      ),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(64);
  });
});

describe('response routes', () => {
  async function seedApp(responses: boolean) {
    await db.insert(schema.apps).values({
      id: 'answers-app',
      slug: 'answers-app',
      name: 'Answers',
      status: 'deployed',
      capabilities: {
        database: false,
        frontend: false,
        widgets: false,
        backend: true,
        cron: false,
        webhook: false,
        kv: false,
        notifications: true,
      },
      signingSecret: 'answers-secret',
      currentDeploymentId: 'answers-deployment',
    });
    const manifest = {
      id: 'answers-app',
      name: 'Answers',
      backend: { entry: 'backend/main.ts' },
      notifications: { kinds: [], destination: { responses } },
    };
    await db.insert(schema.deployments).values({
      id: 'answers-deployment',
      appId: 'answers-app',
      version: 1,
      compatibilityVersion: 2,
      status: 'deployed',
      manifestNormalized: manifest,
    });
    await db.transaction((tx) =>
      syncAppNotificationDestination(
        tx,
        'answers-app',
        'Answers',
        manifest as never,
      ),
    );
    const row = await db.query.notificationDestinations.findFirst({
      where: { appId: 'answers-app' },
    });
    return row!.id;
  }

  it('only targets webhooks and Apps that accept responses', async () => {
    await expect(
      service.createResponseRoute({
        sourceType: 'any',
        target: { destinationId: deviceId },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const appDestination = await seedApp(false);
    await expect(
      service.createResponseRoute({
        sourceType: 'any',
        target: { destinationId: appDestination },
      }),
    ).rejects.toMatchObject({ status: 400 });
    const views = await service.listDestinations();
    expect(
      views.find((view) => view.id === appDestination)?.acceptsResponses,
    ).toBe(false);
    expect(views.find((view) => view.id === webhookId)?.acceptsResponses).toBe(
      true,
    );
  });

  it('delivers answers to an App that accepts them, and fails once it stops', async () => {
    const appDestination = await seedApp(true);
    await service.createResponseRoute({
      sourceType: 'any',
      kind: 'deploy',
      target: { destinationId: appDestination },
    });
    vi.mocked(callAppBackend).mockResolvedValue({
      status: 200,
      body: '{"result":"logged"}',
      contentType: 'application/json',
    });
    const id = await sendForm();
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'cli' },
    );
    await runAll();
    const calls = vi.mocked(callAppBackend).mock.calls;
    expect(calls).toHaveLength(1);
    const [, path, init] = calls[0]!;
    expect(path).toBe('/__notification');
    expect(JSON.parse(String(init?.body)).type).toBe(
      'hatch.notification.responded',
    );
    expect(
      (await service.getNotification(id)).responseDeliveryList,
    ).toMatchObject([{ status: 'succeeded', result: 'logged' }]);

    // The App drops `responses`: its next answer fails with a clear reason.
    await db
      .update(schema.deployments)
      .set({
        manifestNormalized: {
          id: 'answers-app',
          name: 'Answers',
          backend: { entry: 'backend/main.ts' },
          notifications: { kinds: [], destination: {} },
        },
      })
      .where(eq(schema.deployments.id, 'answers-deployment'));
    const next = await sendForm();
    await respondToNotification(
      next,
      { decision: 'reject' },
      { userId: 'user-1', via: 'cli' },
    );
    await runAll();
    expect(
      (await service.getNotification(next)).responseDeliveryList,
    ).toMatchObject([
      { status: 'failed', lastError: 'App no longer accepts responses.' },
    ]);
  });

  it('retries a failed answer delivery', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const id = await sendForm();
    webhookStatus = 400;
    await respondToNotification(
      id,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    await runAll();
    const [failed] = (await service.getNotification(id)).responseDeliveryList;
    expect(failed).toMatchObject({ status: 'failed', httpStatus: 400 });

    webhookStatus = 200;
    await service.retryDelivery(failed!.id);
    await runAll();
    expect(
      (await service.getNotification(id)).responseDeliveryList,
    ).toMatchObject([{ status: 'succeeded' }]);
  });
});

describe('timeline order', () => {
  const sender = () => ({ type: 'channel' as const, channelId });
  const activityIds = async (limit?: number, cursor?: string) =>
    service.listNotifications({ order: 'activity', limit, cursor });

  it('moves a notification to the end when its source edits it, but not when someone answers or it is recalled', async () => {
    const first = await sendForm();
    const second = await sendForm();
    // Known activity times a minute apart, both before the edit below, so the
    // order never rests on two pushes landing in the same millisecond.
    for (const [id, minutesAgo] of [
      [first, 2],
      [second, 1],
    ] as const) {
      await db
        .update(schema.notifications)
        .set({ activityAt: new Date(Date.now() - minutesAgo * 60_000) })
        .where(eq(schema.notifications.id, id));
    }
    const idsOf = async () =>
      (await activityIds()).items.map((item) => item.id);
    expect(await idsOf()).toEqual([second, first]);

    await updateNotification(sender(), { id: first, title: 'Deploy v2?' });
    expect(await idsOf()).toEqual([first, second]);
    // The push order stays the creation order.
    expect(
      (await service.listNotifications()).items.map((item) => item.id),
    ).toEqual([second, first]);

    await respondToNotification(
      second,
      { decision: 'approve' },
      { userId: 'user-1', via: 'web' },
    );
    await recallNotification(sender(), first);
    await updateNotification(sender(), { id: second, silent: true });
    expect(await idsOf()).toEqual([first, second]);

    const answered = (await activityIds()).items.find(
      (item) => item.id === second,
    );
    expect(answered?.response).toMatchObject({
      answers: { decision: 'approve' },
      via: 'web',
    });
  });

  it('pages every notification once, also when several share one activity time', async () => {
    const ids = [await sendForm(), await sendForm(), await sendForm()];
    await db
      .update(schema.notifications)
      .set({ activityAt: new Date('2026-11-25T10:00:00Z') });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await activityIds(1, cursor);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...ids].reverse());
    await expect(activityIds(1, ids[0])).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('new questions on the same notification', () => {
  const MERGE_FORM = {
    fields: [
      {
        id: 'merge',
        type: 'buttons',
        label: 'Merge now?',
        options: [
          { id: 'merge', label: 'Merge' },
          { id: 'hold', label: 'Hold' },
        ],
      },
    ],
  };
  const answer = (id: string, answers: Record<string, string>) =>
    respondToNotification(id, answers, { userId: 'user-1', via: 'web' });

  it('takes one answer per round, sends each one along response routes, and keeps what each edit replaced', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const id = await sendForm();
    await answer(id, { decision: 'approve' });
    await runAll();

    // The next question may come with data for it, even though the first
    // round was answered.
    // Through the same schema an App or Channel edit is parsed with.
    await updateNotification(
      { type: 'channel', channelId },
      notificationUpdateSchema.parse({
        id,
        title: 'CI passed',
        data: { pr: 261 },
        reply: MERGE_FORM,
      }),
    );
    let summary = (await service.listNotifications()).items[0]!;
    expect(summary).toMatchObject({
      replyRound: 2,
      respondedAt: null,
      response: null,
    });
    expect(summary.reply?.fields[0]?.id).toBe('merge');

    // The old question is gone: its answers no longer fit.
    await expect(answer(id, { decision: 'approve' })).rejects.toMatchObject({
      status: 400,
    });
    received.length = 0;
    await answer(id, { merge: 'merge' });
    await expect(answer(id, { merge: 'hold' })).rejects.toBeInstanceOf(
      AlreadyRespondedError,
    );
    await runAll();

    const envelopes = received
      .filter(
        (entry) =>
          entry.headers['x-hatch-event'] === 'hatch.notification.responded',
      )
      .map((entry) => JSON.parse(entry.body));
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].notification.response).toMatchObject({
      round: 2,
      answers: { merge: 'merge' },
    });
    summary = (await service.listNotifications()).items[0]!;
    expect(summary.response).toMatchObject({ round: 2 });
    expect(
      (await service.getNotification(id)).responseDeliveryList,
    ).toHaveLength(2);

    const history = await service.listNotificationRevisions(id);
    expect(history.revisions).toMatchObject([
      { title: 'Deploy?', replyRound: 1 },
    ]);
    expect(history.responses.map((response) => response.round)).toEqual([1, 2]);
  });

  it('pages earlier versions newest first, each page with the answers to its rounds', async () => {
    const id = await sendForm();
    // Four answered rounds, each replaced by a new question: rounds 1-5,
    // with round 5 still open.
    for (let round = 1; round <= 4; round += 1) {
      await answer(id, { decision: 'approve' });
      const next = structuredClone(APPROVE_FORM);
      next.fields[0]!.label = `Question ${round + 1}`;
      await updateNotification(
        { type: 'channel', channelId },
        notificationUpdateSchema.parse({ id, reply: next }),
      );
    }
    const first = await service.listNotificationRevisions(id, { limit: 2 });
    expect(first.revisions.map((revision) => revision.replyRound)).toEqual([
      4, 3,
    ]);
    expect(first.responses.map((response) => response.round)).toEqual([3, 4]);
    expect(first.nextCursor).not.toBeNull();

    const last = await service.listNotificationRevisions(id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(last.revisions.map((revision) => revision.replyRound)).toEqual([
      2, 1,
    ]);
    expect(last.responses.map((response) => response.round)).toEqual([1, 2]);
    expect(last.nextCursor).toBeNull();
    await expect(
      service.listNotificationRevisions(id, { cursor: 'nope' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('delivers the answer to an earlier round with what it answered, after a new question changed the data', async () => {
    await service.createResponseRoute({
      sourceType: 'any',
      target: { destinationId: webhookId },
    });
    const response = await pushAsChannel({
      kind: 'deploy',
      title: 'Deploy A?',
      data: { deployment: 'A' },
      reply: APPROVE_FORM,
    });
    const { id } = (await response.json()) as { id: string };
    await runAll();
    // The receiver is down when the answer is given.
    webhookStatus = 503;
    await answer(id, { decision: 'approve' });
    await runAll();
    webhookStatus = 200;
    await updateNotification(
      { type: 'channel', channelId },
      notificationUpdateSchema.parse({
        id,
        title: 'Deploy B?',
        data: { deployment: 'B' },
        reply: MERGE_FORM,
      }),
    );
    received.length = 0;
    await db
      .update(schema.notificationResponseDeliveries)
      .set({ nextAttemptAt: new Date(0) });
    await runAll();

    const [envelope] = received
      .filter(
        (entry) =>
          entry.headers['x-hatch-event'] === 'hatch.notification.responded',
      )
      .map((entry) => JSON.parse(entry.body));
    expect(envelope.notification).toMatchObject({
      title: 'Deploy A?',
      data: { deployment: 'A' },
      reply: { fields: [{ id: 'decision' }] },
      response: { round: 1, answers: { decision: 'approve' } },
    });
  });

  it('refuses an answer to a question an edit has since replaced, on the web and from the push', async () => {
    const id = await sendForm();
    const firstShown = (await service.getNotification(id)).revision;
    // Same field and option ids, a different question.
    const renamed = structuredClone(APPROVE_FORM);
    renamed.fields[0]!.label = 'Roll back the deploy?';
    await updateNotification(
      { type: 'channel', channelId },
      notificationUpdateSchema.parse({ id, reply: renamed }),
    );

    await expect(
      respondToNotification(
        id,
        { decision: 'approve' },
        { userId: 'user-1', via: 'web' },
        { round: 1 },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'notifications.replyRoundChanged',
    });
    // The phone still shows the first question until the edit reaches it.
    const stale = await handleDeviceResponse(
      deviceRequest({ notificationId: id, answers: { decision: 'approve' } }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'QUESTION_CHANGED' },
    });
    expect((await service.getNotification(id)).response).toBeNull();

    await runAll();
    // A tap on the first question arriving after the phone got the second:
    // it names the revision its notification showed.
    const late = await handleDeviceResponse(
      deviceRequest({
        notificationId: id,
        answers: { decision: 'approve' },
        revision: firstShown,
      }),
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({
      error: { code: 'QUESTION_CHANGED' },
    });
    // An app build that sends no revision answers only the first question.
    const unbound = await handleDeviceResponse(
      deviceRequest({ notificationId: id, answers: { decision: 'approve' } }),
    );
    expect(unbound.status).toBe(409);
    const current = await handleDeviceResponse(
      deviceRequest({
        notificationId: id,
        answers: { decision: 'reject' },
        revision: (await service.getNotification(id)).revision,
      }),
    );
    expect(current.status).toBe(200);
    expect((await service.getNotification(id)).response).toMatchObject({
      round: 2,
      answers: { decision: 'reject' },
    });
  });

  it('asks nothing after the form is removed, and repeating the same form starts no round', async () => {
    const id = await sendForm();
    const sender = { type: 'channel' as const, channelId };
    const form = (await service.getNotification(id)).reply!;
    await updateNotification(sender, { id, reply: form, silent: true });
    expect((await service.getNotification(id)).replyRound).toBe(1);

    await updateNotification(sender, { id, reply: null });
    const detail = await service.getNotification(id);
    expect(detail).toMatchObject({ reply: null, replyRound: 2 });
    await expect(answer(id, { decision: 'approve' })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('earlier versions', () => {
  it('keep everything a version showed, the tap-opens-link setting included, and are counted on the notification', async () => {
    const response = await pushAsChannel({
      kind: 'deploy',
      title: 'Deploy #88 queued',
      url: 'https://deploy.example.test/runs/88',
      autoOpenUrl: true,
    });
    const { id } = (await response.json()) as { id: string };
    expect((await service.getNotification(id)).earlierVersions).toBe(0);

    const sender = { type: 'channel' as const, channelId };
    await updateNotification(sender, {
      id,
      title: 'Deploy #88 running',
      autoOpenUrl: false,
    });
    await recallNotification(sender, id);

    const detail = await service.getNotification(id);
    expect(detail).toMatchObject({
      title: 'Deploy #88 running',
      autoOpenUrl: false,
      earlierVersions: 1,
    });
    expect(detail.recalledAt).not.toBeNull();
    expect(
      (await service.listNotifications({ order: 'activity' })).items.find(
        (item) => item.id === id,
      )?.earlierVersions,
    ).toBe(1);
    expect((await service.listNotificationRevisions(id)).revisions).toEqual([
      expect.objectContaining({
        title: 'Deploy #88 queued',
        url: 'https://deploy.example.test/runs/88',
        autoOpenUrl: true,
      }),
    ]);
  });
});

const TEXT_PUSH = { kind: 'deploy', title: 'Deploy #88', body: 'Queued' };
const MARKDOWN_PUSH = {
  kind: 'deploy',
  markdown: '## Release v12\n\n- Fixes the login **redirect**',
  summary: 'v12 released',
};
const CARD_PUSH = {
  kind: 'deploy',
  card: '<Card status="CI failed" tone="danger" flag="Urgent"><Title>PR #261</Title><Text>e2e/login failed</Text></Card>',
  summary: 'PR #261 CI failed',
};
const LEGACY_CARD = {
  status: { label: 'Running', tone: 'info' },
  block: { type: 'progress', label: 'Checks', percent: 21, value: '3 / 14' },
} as const;
const LEGACY_PUSH = {
  kind: 'deploy',
  title: 'CI running',
  body: 'Started by Ada',
  card: LEGACY_CARD,
};
/** APPROVE_FORM written inside the card. */
const INLINE_PUSH = {
  kind: 'deploy',
  card: `<Card><Title>Deploy?</Title>
    <Buttons id="decision" label="Approve the deploy?">
      <Button id="approve">Approve</Button>
      <Button id="reject" destructive>Reject</Button>
    </Buttons></Card>`,
  summary: 'Deploy waiting for approval',
};

async function pushed(body: Record<string, unknown>) {
  const response = await pushAsChannel(body);
  const text = await response.text();
  expect({ status: response.status, text }).toMatchObject({ status: 202 });
  const { id } = JSON.parse(text) as { id: string };
  await runAll();
  return id;
}

describe('content', () => {
  it('shows each format on the phone and in webhook envelopes', async () => {
    const markdownTree = compileMarkdown(MARKDOWN_PUSH.markdown);
    const cases = [
      {
        push: TEXT_PUSH,
        stored: { format: 'text', title: 'Deploy #88', summary: null },
        phone: { t: 'Deploy #88', b: 'Queued' },
        envelope: { title: 'Deploy #88', body: 'Queued', card: null },
      },
      {
        push: { ...TEXT_PUSH, summary: 'Deploy queued' },
        stored: {
          format: 'text',
          title: 'Deploy #88',
          summary: 'Deploy queued',
        },
        phone: { t: 'Deploy #88', b: 'Deploy queued' },
        envelope: { title: 'Deploy #88', body: 'Queued', card: null },
      },
      {
        push: MARKDOWN_PUSH,
        stored: {
          format: 'markdown',
          title: null,
          body: null,
          summary: 'v12 released',
          markdown: MARKDOWN_PUSH.markdown,
          content: markdownTree,
        },
        phone: { t: 'CI', b: 'v12 released', ks: 1 },
        envelope: {
          title: 'v12 released',
          body: contentToPlainText(markdownTree),
          markdown: MARKDOWN_PUSH.markdown,
          content: markdownTree,
          card: null,
        },
      },
      {
        push: CARD_PUSH,
        stored: { format: 'card', title: null, summary: 'PR #261 CI failed' },
        phone: { t: 'CI', b: 'PR #261 CI failed', ks: 1 },
        envelope: {
          title: 'PR #261 CI failed',
          body: 'CI failed · Urgent\nPR #261\ne2e/login failed',
          markdown: null,
          card: { status: { label: 'CI failed', tone: 'danger' } },
        },
      },
    ];
    for (const { push, stored, phone, envelope } of cases) {
      received.length = 0;
      deviceCalls.length = 0;
      const id = await pushed(push);
      expect(await service.getNotification(id)).toMatchObject(stored);
      const [call] = deviceCalls;
      const plaintext = pushPlaintext(call!.notification, call!.event, 'o');
      expect({ t: plaintext.t, b: plaintext.b, ks: plaintext.ks }).toEqual({
        ks: undefined,
        ...phone,
      });
      const sent = JSON.parse(received[0]!.body);
      expect(sent.notification).toMatchObject({
        format: stored.format,
        summary: stored.summary,
        ...envelope,
      });
    }
  });

  it('rejects content it cannot use and says what to fix', async () => {
    const rejected = async (body: Record<string, unknown>) => {
      const response = await pushAsChannel(body);
      expect(response.status).toBe(400);
      return response.text();
    };
    const { summary: _markdownSummary, ...markdownOnly } = MARKDOWN_PUSH;
    const { summary: _cardSummary, ...cardOnly } = CARD_PUSH;
    expect(await rejected(markdownOnly)).toBe(
      'summary is required for markdown and card notifications',
    );
    expect(await rejected(cardOnly)).toBe(
      'summary is required for markdown and card notifications',
    );
    // A blank summary is no summary.
    expect(await rejected({ ...CARD_PUSH, summary: '   ' })).toBe(
      'summary is required for markdown and card notifications',
    );
    expect(await rejected({ ...MARKDOWN_PUSH, title: 'Release' })).toMatch(
      /only one content/,
    );
    expect(await rejected({ ...MARKDOWN_PUSH, card: CARD_PUSH.card })).toMatch(
      /only one content/,
    );
    expect(await rejected({ ...MARKDOWN_PUSH, summary: 'v12\nreleased' })).toBe(
      'summary must be one line, without line breaks',
    );
    expect(await rejected({ ...TEXT_PUSH, summary: 'Deploy\r\nqueued' })).toBe(
      'summary must be one line, without line breaks',
    );
    expect(await rejected({ ...INLINE_PUSH, reply: APPROVE_FORM })).toBe(
      'reply: cannot be combined with inputs written in the card',
    );
    expect(await rejected({ kind: 'deploy', card: LEGACY_CARD })).toMatch(
      /needs a title/,
    );
    // Parser positions reach the sender as the parser wrote them.
    const markup = '<Card>\n  <Title>PR</Title>\n  <Bogus/>\n</Card>';
    let parserMessage = '';
    try {
      compileCard(markup);
    } catch (error) {
      parserMessage = (error as Error).message;
    }
    expect(parserMessage).toMatch(/^3:\d+: /);
    expect(
      await rejected({ kind: 'deploy', card: markup, summary: 'PR' }),
    ).toBe(`card: ${parserMessage}`);
  });

  it('turns a #319 card into a card notification that reads back the same', async () => {
    received.length = 0;
    const id = await pushed(LEGACY_PUSH);
    const legacy = {
      title: LEGACY_PUSH.title,
      body: LEGACY_PUSH.body,
      card: LEGACY_CARD,
    };
    expect(await service.getNotification(id)).toMatchObject({
      format: 'card',
      title: null,
      body: null,
      summary: summaryFromTitle(LEGACY_PUSH.title),
      content: legacyToContent(legacy),
    });
    // Receivers that read `card` still get the card they were sent.
    const sent = JSON.parse(received[0]!.body);
    expect(sent.notification).toMatchObject({
      title: 'CI running',
      card: LEGACY_CARD,
    });
  });

  it('applies edits by the format they leave the notification in', async () => {
    const sender = { type: 'channel' as const, channelId };
    const cases: {
      name: string;
      push: Record<string, unknown>;
      update: Record<string, unknown>;
      expected: Record<string, unknown> | RegExp;
    }[] = [
      {
        name: 'text to markdown',
        push: TEXT_PUSH,
        update: { markdown: '# Notes', summary: 'Notes' },
        expected: {
          format: 'markdown',
          title: null,
          body: null,
          summary: 'Notes',
          markdown: '# Notes',
        },
      },
      {
        name: 'text to markdown without a summary',
        push: TEXT_PUSH,
        update: { markdown: '# Notes' },
        expected: /^summary is required/,
      },
      {
        name: 'text with a summary to a card, keeping it',
        push: { ...TEXT_PUSH, summary: 'Deploy queued' },
        update: { card: CARD_PUSH.card },
        expected: { format: 'card', title: null, summary: 'Deploy queued' },
      },
      {
        name: 'markdown to text, keeping the summary',
        push: MARKDOWN_PUSH,
        update: { title: 'Released' },
        expected: {
          format: 'text',
          title: 'Released',
          body: null,
          summary: 'v12 released',
          markdown: null,
          content: null,
        },
      },
      {
        name: 'markdown with only a body',
        push: MARKDOWN_PUSH,
        update: { body: 'More' },
        expected: /^title is required/,
      },
      {
        name: 'removing the summary of a card',
        push: CARD_PUSH,
        update: { summary: null },
        expected: /^summary is required/,
      },
      {
        name: 'removing the summary of text',
        push: { ...TEXT_PUSH, summary: 'Deploy queued' },
        update: { summary: null },
        expected: { format: 'text', summary: null },
      },
      {
        name: 'a #319 card retitled, its summary following',
        push: LEGACY_PUSH,
        update: { title: 'CI passed' },
        expected: {
          format: 'card',
          summary: 'CI passed',
          content: legacyToContent({
            title: 'CI passed',
            body: LEGACY_PUSH.body,
            card: LEGACY_CARD,
          }),
        },
      },
      {
        name: 'a #319 card with its own summary retitled',
        push: { ...LEGACY_PUSH, summary: 'Nightly CI' },
        update: { title: 'CI passed' },
        expected: { format: 'card', summary: 'Nightly CI' },
      },
      {
        name: 'a #319 card removed',
        push: LEGACY_PUSH,
        update: { card: null },
        expected: {
          format: 'text',
          title: 'CI running',
          body: 'Started by Ada',
          summary: null,
          content: null,
        },
      },
      {
        name: 'a #319 card added to text',
        push: TEXT_PUSH,
        update: { card: { status: { label: 'Done', tone: 'success' } } },
        expected: {
          format: 'card',
          summary: 'Deploy #88',
          content: legacyToContent({
            title: 'Deploy #88',
            body: 'Queued',
            card: { status: { label: 'Done', tone: 'success' } },
          }),
        },
      },
      {
        name: 'a #319 card given to a free-form card without a title',
        push: CARD_PUSH,
        update: { card: { status: { label: 'Done', tone: 'success' } } },
        expected: /^title is required/,
      },
      {
        name: 'a free-form card replaced by a title and a #319 card',
        push: CARD_PUSH,
        update: {
          title: 'Fixed',
          card: { status: { label: 'Done', tone: 'success' } },
        },
        expected: {
          format: 'card',
          summary: 'PR #261 CI failed',
          content: legacyToContent({
            title: 'Fixed',
            body: null,
            card: { status: { label: 'Done', tone: 'success' } },
          }),
        },
      },
      {
        name: 'markdown and a title at once',
        push: MARKDOWN_PUSH,
        update: { markdown: '# New', title: 'New' },
        expected: /only one content/,
      },
      {
        name: 'a card that drops its inline inputs',
        push: INLINE_PUSH,
        update: { card: CARD_PUSH.card },
        expected: { format: 'card', reply: null, replyRound: 2 },
      },
      {
        name: 'a reply replacing inline inputs',
        push: INLINE_PUSH,
        update: { reply: APPROVE_FORM },
        expected: /^reply cannot replace the inputs/,
      },
      {
        name: 'a reply beside new inline inputs',
        push: CARD_PUSH,
        update: { card: INLINE_PUSH.card, reply: APPROVE_FORM },
        expected: /^reply: cannot be combined/,
      },
    ];
    for (const { name, push, update, expected } of cases) {
      const id = await pushed(push);
      const response = await applyLifecycleRequest(sender, 'update', {
        id,
        ...update,
      });
      const message = response.status === 200 ? null : await response.text();
      // `matches` says whether a rejection said what the case expects.
      const outcome = {
        name,
        status: response.status,
        message,
        matches: expected instanceof RegExp && expected.test(message ?? ''),
        view: message === null ? await service.getNotification(id) : null,
      };
      expect(outcome).toMatchObject(
        expected instanceof RegExp
          ? { name, status: 400, matches: true }
          : { name, status: 200, view: expected },
      );
    }
  });

  it('asks inline inputs as the reply form they spell out', async () => {
    const handWritten = await sendForm();
    deviceCalls.length = 0;
    const inline = await pushed(INLINE_PUSH);
    const stored = await service.getNotification(inline);
    expect(stored.reply).toEqual(
      (await service.getNotification(handWritten)).reply,
    );
    // Tapping the push still opens the form, and its buttons answer it.
    expect(stored.autoOpenUrl).toBe(false);
    const [call] = deviceCalls;
    expect(pushPlaintext(call!.notification, call!.event, 'o').q).toEqual({
      m: 'b',
      f: 'decision',
      a: [
        { i: 'approve', l: 'Approve' },
        { i: 'reject', l: 'Reject', d: 1 },
      ],
    });
    await respondToNotification(
      inline,
      { decision: 'reject' },
      { userId: 'user-1', via: 'web' },
    );
    expect((await service.getNotification(inline)).response).toMatchObject({
      answers: { decision: 'reject' },
    });
  });
});
