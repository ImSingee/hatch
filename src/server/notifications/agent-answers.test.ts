/**
 * Answers the Agent acts on: the chat whose Run asked gets the answer, Agent
 * response routes open one chat per notification (reused by later questions)
 * or use a fixed one, and the Agent's own answers never come back to it.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});
vi.mock('~server/agent-pending-messages', () => ({
  enqueuePendingMessage:
    vi.fn<
      typeof import('~server/agent-pending-messages').enqueuePendingMessage
    >(),
}));
vi.stubEnv('APP_URL', 'https://hatch.example.test');
vi.stubEnv('SECRET', 'platform-secret');
vi.mock('~server/agent-model-catalog', () => ({
  getAgentModelCatalog: async () => ({
    providers: [],
    defaultModel: { providerId: 'provider-1', modelId: 'model-default' },
  }),
}));

const { db, schema } = await import('~/db');
const { enqueuePendingMessage } =
  await import('~server/agent-pending-messages');
const service = await import('./service');
const { respondToNotification } = await import('./responses');
const { updateNotification } = await import('./lifecycle');
const { notificationUpdateSchema } = await import('./contract');

const FORM = {
  fields: [
    {
      id: 'decision',
      type: 'buttons',
      label: 'Fix it?',
      required: true,
      options: [
        { id: 'fix', label: 'Fix it' },
        { id: 'skip', label: 'Leave it' },
      ],
    },
  ],
  submitLabel: 'Send',
} as const;

const enqueued = vi.mocked(enqueuePendingMessage);
let channelId = '';

async function notification(
  values: Partial<typeof schema.notifications.$inferInsert>,
) {
  const id =
    `n${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`.padEnd(
      26,
      '0',
    );
  await db.insert(schema.notifications).values({
    id,
    sourceType: 'channel',
    channelId,
    sourceName: 'GitHub',
    kind: 'pr',
    kindName: 'Pull request',
    title: 'PR #261 CI failed',
    occurredAt: new Date(),
    reply: FORM as never,
    ...values,
  });
  return id;
}

const answer = (id: string, userId: string | null = 'user-1', value = 'fix') =>
  respondToNotification(
    id,
    { decision: value },
    userId
      ? { userId, via: 'web' }
      : { userId: null, name: 'Hatch Agent', via: 'cli' },
  );

beforeEach(async () => {
  enqueued.mockReset();
  enqueued.mockResolvedValue({ pending: [], startedRunId: null } as never);
  await db.delete(schema.notifications);
  await db.delete(schema.notificationResponseRoutes);
  await db.delete(schema.notificationChannels);
  await db.delete(schema.agentSessions);
  await db.delete(schema.user);
  await db.insert(schema.user).values({
    id: 'user-1',
    name: 'Ada',
    email: 'ada@example.test',
  });
  channelId = (
    await service.createChannel({
      name: 'GitHub',
      kinds: [{ kind: 'pr', name: 'Pull request' }],
    })
  ).channel.id;
});

describe('answers handed to the Agent', () => {
  it('go back to the chat whose Run asked, sent as the person who answered', async () => {
    await db.insert(schema.agentSessions).values({
      id: 'session-asked',
      providerId: 'provider-1',
      modelId: 'model-chat',
    });
    const id = await notification({
      sourceType: 'platform',
      channelId: null,
      sourceName: 'Hatch Agent',
      agentSessionId: 'session-asked',
    });
    await answer(id);
    await vi.waitFor(() => expect(enqueued).toHaveBeenCalledTimes(1));
    const call = enqueued.mock.calls[0]![0];
    expect(call).toMatchObject({
      sessionId: 'session-asked',
      userId: 'user-1',
      providerId: 'provider-1',
      modelId: 'model-chat',
      clientMessageId: `notification-answer:${id}:1`,
    });
    expect(JSON.stringify(call.message.content)).toContain('Fix it?: Fix it');
  });

  it('never come back when the Agent answered itself', async () => {
    await db.insert(schema.agentSessions).values({ id: 'session-asked' });
    const id = await notification({
      sourceType: 'platform',
      channelId: null,
      sourceName: 'Hatch Agent',
      agentSessionId: 'session-asked',
    });
    await answer(id, null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enqueued).not.toHaveBeenCalled();
  });

  it('open one chat per notification for an Agent route and reuse it for the next question', async () => {
    await service.createResponseRoute({
      sourceType: 'channel',
      sourceId: channelId,
      target: {
        agent: { sessionId: null, instructions: 'Fix the failing check.' },
      },
    });
    const id = await notification({});
    await answer(id);
    await vi.waitFor(() => expect(enqueued).toHaveBeenCalledTimes(1));
    const [row] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, id));
    expect(row!.agentSessionId).not.toBeNull();
    const first = enqueued.mock.calls[0]![0];
    expect(first).toMatchObject({
      sessionId: row!.agentSessionId,
      providerId: 'provider-1',
      modelId: 'model-default',
    });
    expect(JSON.stringify(first.message.content)).toContain(
      'Fix the failing check.',
    );

    await updateNotification(
      { type: 'channel', channelId },
      notificationUpdateSchema.parse({
        id,
        title: 'PR #261 CI passed',
        reply: {
          fields: [
            {
              id: 'decision',
              type: 'buttons',
              label: 'Merge?',
              options: [
                { id: 'fix', label: 'Merge' },
                { id: 'skip', label: 'Hold' },
              ],
            },
          ],
        },
      }),
    );
    await answer(id);
    await vi.waitFor(() => expect(enqueued).toHaveBeenCalledTimes(2));
    expect(enqueued.mock.calls[1]![0]).toMatchObject({
      sessionId: row!.agentSessionId,
      clientMessageId: `notification-answer:${id}:2`,
    });
    expect(await db.select().from(schema.agentSessions)).toHaveLength(1);
  });

  it('use the fixed chat of a route, which must exist', async () => {
    await db.insert(schema.agentSessions).values({ id: 'session-fixed' });
    await expect(
      service.createResponseRoute({
        sourceType: 'any',
        target: { agent: { sessionId: 'session-gone', instructions: null } },
      }),
    ).rejects.toMatchObject({ status: 404 });
    const route = await service.createResponseRoute({
      sourceType: 'any',
      target: { agent: { sessionId: 'session-fixed', instructions: null } },
    });
    expect(route).toMatchObject({
      targetType: 'agent',
      destinationId: null,
      agentSessionId: 'session-fixed',
    });
    const id = await notification({});
    await answer(id);
    await vi.waitFor(() => expect(enqueued).toHaveBeenCalledTimes(1));
    expect(enqueued.mock.calls[0]![0].sessionId).toBe('session-fixed');
  });
});
