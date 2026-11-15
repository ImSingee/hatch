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
      destinationId: webhookId,
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
    expect(
      pushPlaintext(
        update.notification,
        update.event,
        'https://o',
        update.response,
      ).q,
    ).toEqual({ m: 'x', s: 'Answered by Bob: Approve' });

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
      destinationId: webhookId,
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
      destinationId: webhookId,
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
      destinationId: webhookId,
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
      destinationId: webhookId,
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
      destinationId: webhookId,
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
      destinationId: webhookId,
    });
    await Promise.all([
      service.updateResponseRoute({ id: route.id, enabled: false }),
      service.updateResponseRoute({ id: route.id, name: 'Renamed' }),
    ]);
    const [stored] = await service.listResponseRoutes();
    expect(stored).toMatchObject({ name: 'Renamed', enabled: false });
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
        destinationId: deviceId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const appDestination = await seedApp(false);
    await expect(
      service.createResponseRoute({
        sourceType: 'any',
        destinationId: appDestination,
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
      destinationId: appDestination,
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
      destinationId: webhookId,
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
