import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '~/db/schema';
import type { RunStartPayload } from '~agent/protocol';

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

vi.mock('~server/agent-runner/hub', () => {
  type Hub = typeof import('~server/agent-runner/hub');
  return {
    connectedRunnerCount: vi.fn<Hub['connectedRunnerCount']>(() => 1),
    listConnectedRunners: vi.fn<Hub['listConnectedRunners']>(),
    dispatchRun: vi.fn<Hub['dispatchRun']>(),
    sendRunAnswer: vi.fn<Hub['sendRunAnswer']>(),
    sendRunCancel: vi.fn<Hub['sendRunCancel']>(() => false),
    sendRunEnvAndWait: vi.fn<Hub['sendRunEnvAndWait']>(),
    sendRunSteer: vi.fn<Hub['sendRunSteer']>(() => true),
    waitForRunFinished: vi.fn<Hub['waitForRunFinished']>(async () => {}),
  };
});

const { db, schema } = await import('~/db');
const hub = await import('~server/agent-runner/hub');
const runs = await import('./agent-runs');
const pending = await import('./agent-pending-messages');
const { updateAgentPreferences } = await import('./agent-preferences');
const { loadSessionDetail } = await import('./agent-session-store');

const RUNNER = 'runner-test';
const SESSION = 'session-1';
const USER = 'user-1';
const MODEL = { providerId: 'provider-a', modelId: 'model-a' };

/** `run.start` payloads in dispatch order. */
let started: RunStartPayload[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  started = [];
  vi.mocked(hub.connectedRunnerCount).mockReturnValue(1);
  vi.mocked(hub.listConnectedRunners).mockReturnValue([
    {
      runnerId: RUNNER,
      protocolVersion: 21,
      activeRunCount: 0,
      connectedAt: '2026-11-20T00:00:00.000Z',
      lastSeenAt: '2026-11-20T00:00:00.000Z',
    },
  ]);
  vi.mocked(hub.sendRunCancel).mockReturnValue(false);
  vi.mocked(hub.dispatchRun).mockImplementation(async (payload, plan) => {
    started.push(payload);
    await plan.assign(RUNNER);
    await plan.finalize(RUNNER);
    return RUNNER;
  });
  await runs.pendingDispatchesSettled();
  await db.delete(schema.agentPendingMessages);
  await db.delete(schema.agentRunEvents);
  await db.delete(schema.agentRuns);
  await db.delete(schema.agentAttachments);
  await db.delete(schema.agentSessions);
  await db.delete(schema.agentModels);
  await db.delete(schema.agentProviders);
  await db.delete(schema.userPreferences);
  await db.delete(schema.user);
  await db.insert(schema.user).values({
    id: USER,
    name: 'Ada',
    email: 'ada@example.test',
  });
  await db.insert(schema.agentProviders).values({
    id: MODEL.providerId,
    name: 'Provider',
    apiType: 'openai-responses',
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'test-key',
  });
  await db.insert(schema.agentModels).values({
    providerId: MODEL.providerId,
    modelId: MODEL.modelId,
    name: 'Model',
    reasoning: false,
    contextWindow: 128_000,
    maxTokens: 8_192,
  });
  await db.insert(schema.agentSessions).values({
    id: SESSION,
    ...MODEL,
    messages: [],
  });
});

const text = (value: string) => [{ type: 'text' as const, text: value }];

async function startRun(prompt: string) {
  const { runId } = await runs.startAgentRun({
    sessionId: SESSION,
    content: text(prompt),
    ...MODEL,
    userId: USER,
  });
  return runId;
}

async function send(message: string) {
  return pending.enqueuePendingMessage({
    sessionId: SESSION,
    userId: USER,
    ...MODEL,
    message: { content: text(message) },
  });
}

async function finish(
  runId: string,
  status: 'completed' | 'failed' | 'cancelled' = 'completed',
  messages?: JsonValue[],
) {
  const session = await db.query.agentSessions.findFirst({
    where: { id: SESSION },
  });
  await runs.completeRunFromRunner(RUNNER, {
    runId,
    status,
    ...(status === 'failed' ? { error: 'Provider failed.' } : {}),
    messages: messages ?? [
      ...(session!.messages as JsonValue[]),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ],
  });
  await runs.pendingDispatchesSettled();
}

async function tray() {
  return (await loadSessionDetail(SESSION))!.pending;
}

async function activeRunId() {
  return (await runs.getActiveAgentRun(SESSION))?.id ?? null;
}

describe('queued messages', () => {
  it('start one run per message, in send order, after each run completes', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const first = await startRun('Build a tracker');
    await send('Add a chart');
    await send('Then deploy it');
    expect((await tray()).messages.map((message) => message.text)).toEqual([
      'Add a chart',
      'Then deploy it',
    ]);
    expect(hub.sendRunSteer).not.toHaveBeenCalled();

    await finish(first);
    const second = await activeRunId();
    expect(started.at(-1)?.userText).toBe('Add a chart');
    expect((await tray()).messages.map((message) => message.text)).toEqual([
      'Then deploy it',
    ]);

    await finish(second!);
    expect(started.at(-1)?.userText).toBe('Then deploy it');
    expect((await tray()).messages).toEqual([]);
    // Every run answers its own user turn.
    const session = await loadSessionDetail(SESSION);
    expect(session!.activeRun?.userTurn).toBe(2);
  });

  it('is delivered at once when the session is idle', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const result = await send('Hello');
    expect(result.startedRunId).toBe(await activeRunId());
    expect(result.pending.messages).toEqual([]);
    expect(started[0]?.userText).toBe('Hello');
  });
});

describe('steer messages', () => {
  it('are claimed together at the next boundary and leave the tray when injected', async () => {
    const runId = await startRun('Build a tracker');
    await send('Use blue');
    await send('And a dark theme');
    expect(hub.sendRunSteer).toHaveBeenCalledWith(RUNNER, runId);
    // Still the user's to change before the claim.
    const [blue] = (await tray()).messages;
    await pending.updatePendingMessage({
      sessionId: SESSION,
      messageId: blue.id,
      message: { content: text('Use navy') },
    });

    const claimed = await runs.claimSteerMessages(RUNNER, runId);
    expect(claimed.map((message) => message.userText)).toEqual([
      'Use navy',
      'And a dark theme',
    ]);
    expect((await tray()).messages.map((message) => message.status)).toEqual([
      'claimed',
      'claimed',
    ]);
    await expect(
      pending.cancelPendingMessage({ sessionId: SESSION, messageId: blue.id }),
    ).rejects.toMatchObject({ status: 409 });
    // Another Runner cannot claim, and nothing is claimed twice.
    expect(await runs.claimSteerMessages('runner-other', runId)).toEqual([]);
    expect(await runs.claimSteerMessages(RUNNER, runId)).toEqual([]);

    for (const [index, message] of claimed.entries()) {
      await runs.ingestRunnerEvent(RUNNER, {
        runId,
        runnerSeq: index + 1,
        event: {
          type: 'user_message',
          pendingId: message.id,
          text: message.userText,
          images: [],
        },
      });
    }
    expect((await tray()).messages).toEqual([]);

    const session = await db.query.agentSessions.findFirst({
      where: { id: SESSION },
    });
    await finish(runId, 'completed', [
      ...(session!.messages as JsonValue[]),
      ...claimed.map((message) => ({
        role: 'user',
        content: [{ type: 'text', text: message.userText }],
        steered: true,
        pendingMessageId: message.id,
      })),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]);
    expect((await tray()).messages).toEqual([]);
    expect(await db.select().from(schema.agentPendingMessages)).toEqual([]);
    // Steered messages belong to the run's reply, not new user turns.
    expect(await activeRunId()).toBeNull();
    expect((await loadSessionDetail(SESSION))!.runs).toHaveLength(1);
  });

  it('still waiting when the run ends are delivered together as the next run', async () => {
    const runId = await startRun('Build a tracker');
    await send('Use blue');
    await send('And a dark theme');
    // Claimed but never injected (the run ended at that boundary).
    await runs.claimSteerMessages(RUNNER, runId);

    await finish(runId);
    expect(started.at(-1)?.userText).toBe('Use blue\n\nAnd a dark theme');
    expect((await tray()).messages).toEqual([]);
  });

  it('marks the next run when steer messages already wait for it', async () => {
    const first = await startRun('Build a tracker');
    await pending.sendPendingMessageNow({
      sessionId: SESSION,
      messageId: (await send('Use blue')).pending.messages[0].id,
      userId: USER,
    });
    expect(first).not.toBe(await activeRunId());
    await send('And a dark theme');
    await send('Fix the title');
    const leftover = (await tray()).messages[0];
    await pending.sendPendingMessageNow({
      sessionId: SESSION,
      messageId: leftover.id,
      userId: USER,
    });
    expect(started.at(-1)).toMatchObject({
      userText: 'And a dark theme',
      steerPending: true,
    });
  });
});

describe('steer delivery edge cases', () => {
  it('notifies the Runner of a steer message sent while its run was dispatched', async () => {
    vi.mocked(hub.dispatchRun).mockImplementationOnce(async (payload, plan) => {
      started.push(payload);
      // Not assigned yet: nothing can be notified.
      await send('Use blue');
      await plan.assign(RUNNER);
      await plan.finalize(RUNNER);
      return RUNNER;
    });
    const runId = await startRun('Build a tracker');
    expect(started[0].steerPending).toBeUndefined();
    expect(hub.sendRunSteer).toHaveBeenLastCalledWith(RUNNER, runId);
  });

  it('splits waiting steer messages that do not fit one message', async () => {
    const runId = await startRun('Build a tracker');
    await send('a'.repeat(60_000));
    await send('b'.repeat(60_000));
    await finish(runId);
    expect(started.at(-1)).toMatchObject({
      userText: 'a'.repeat(60_000),
      steerPending: true,
    });
    expect((await tray()).messages.map((message) => message.text)).toEqual([
      'b'.repeat(60_000),
    ]);
  });

  it('keeps the session revision when delivery pauses', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');
    await finish(runId, 'failed');
    const before = (await loadSessionDetail(SESSION))!.updatedAt;
    await runs.stopAgentAutoRetry(SESSION);
    const after = await loadSessionDetail(SESSION);
    expect(after!.pending.paused).toBe(true);
    expect(after!.updatedAt).toBe(before);
  });
});

describe('review regressions', () => {
  it('keeps a message edited after its run stopped when a late report arrives', async () => {
    const runId = await startRun('Build a tracker');
    await send('Use blue');
    const [claimed] = await runs.claimSteerMessages(RUNNER, runId);
    await runs.ingestRunnerEvent(RUNNER, {
      runId,
      runnerSeq: 1,
      event: {
        type: 'user_message',
        pendingId: claimed.id,
        text: 'Use blue',
        images: [],
      },
    });
    // Stopped while the Runner is away: the message is the user's again.
    await runs.cancelAgentRun(runId);
    await runs.pendingDispatchesSettled();
    await pending.updatePendingMessage({
      sessionId: SESSION,
      messageId: claimed.id,
      message: { content: text('Use red') },
    });
    const session = await db.query.agentSessions.findFirst({
      where: { id: SESSION },
    });
    await finish(runId, 'cancelled', [
      ...(session!.messages as JsonValue[]),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Use blue' }],
        steered: true,
        pendingMessageId: claimed.id,
      },
    ]);
    expect((await tray()).messages.map((message) => message.text)).toEqual([
      'Use red',
    ]);
  });

  it('restores injected steer messages ahead of ones sent after them', async () => {
    const runId = await startRun('Build a tracker');
    await send('Use blue');
    const [claimed] = await runs.claimSteerMessages(RUNNER, runId);
    await send('Actually use red');
    const session = await db.query.agentSessions.findFirst({
      where: { id: SESSION },
    });
    await finish(runId, 'failed', [
      ...(session!.messages as JsonValue[]),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Use blue' }],
        steered: true,
        pendingMessageId: claimed.id,
      },
    ]);
    await runs.stopAgentAutoRetry(SESSION);
    const failed = await db.query.agentSessions.findFirst({
      where: { id: SESSION },
    });
    await runs.startAgentRun({
      sessionId: SESSION,
      retry: true,
      expectedSessionUpdatedAt: failed!.updatedAt.toISOString(),
      ...MODEL,
      userId: USER,
    });
    const retryRun = await activeRunId();
    expect(
      (await runs.claimSteerMessages(RUNNER, retryRun!)).map(
        (message) => message.userText,
      ),
    ).toEqual(['Use blue', 'Actually use red']);
  });

  it('defers automatic delivery under the lock when paused or a retry is due', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');
    const [message] = (await tray()).messages;
    await finish(runId, 'failed');
    // A retry is scheduled: automatic delivery waits, Send now does not.
    await expect(
      runs.startAgentRun({
        sessionId: SESSION,
        pendingMessageIds: [message.id],
        ...MODEL,
        automatic: true,
      }),
    ).rejects.toBeInstanceOf(runs.PendingDeliveryDeferredError);
    await runs.stopAgentAutoRetry(SESSION);
    await expect(
      runs.startAgentRun({
        sessionId: SESSION,
        pendingMessageIds: [message.id],
        ...MODEL,
        automatic: true,
      }),
    ).rejects.toBeInstanceOf(runs.PendingDeliveryDeferredError);
    expect((await tray()).messages).toHaveLength(1);
  });

  it('leaves messages waiting while the workspace owner Runner is away', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');
    vi.mocked(hub.listConnectedRunners).mockReturnValue([]);
    await finish(runId);
    expect(await activeRunId()).toBeNull();
    expect((await tray()).messages.map((message) => message.text)).toEqual([
      'Add a chart',
    ]);
    expect((await tray()).paused).toBe(false);
  });

  it('keeps a pause from a stopped retry when a late success repairs the run', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');
    await runs.interruptAgentRun(runId, 'Runner went away.');
    await runs.stopAgentAutoRetry(SESSION);
    expect((await tray()).paused).toBe(true);
    await finish(runId, 'completed');
    expect((await runs.getAgentRun(runId))?.status).toBe('completed');
    expect(await activeRunId()).toBeNull();
    expect((await tray()).paused).toBe(true);
  });
});

describe('pausing and Send now', () => {
  it('pauses after a Stop until the user resumes', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');

    await runs.cancelAgentRun(runId);
    await runs.pendingDispatchesSettled();
    expect(await activeRunId()).toBeNull();
    expect((await tray()).paused).toBe(true);

    const resumed = await pending.resumePendingMessages(SESSION);
    expect(resumed.startedRunId).toBe(await activeRunId());
    expect(started.at(-1)?.userText).toBe('Add a chart');
    expect(resumed.pending).toEqual({ paused: false, messages: [] });
  });

  it('waits for an automatic retry and pauses once it is stopped', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');

    await finish(runId, 'failed');
    expect(await activeRunId()).toBeNull();
    expect((await tray()).paused).toBe(false);

    await runs.stopAgentAutoRetry(SESSION);
    expect((await tray()).paused).toBe(true);
  });

  it('stops the active run, starts the chosen message and keeps the rest flowing', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await send('Add a chart');
    await send('Deploy it now');
    const [chart, deploy] = (await tray()).messages;

    const result = await pending.sendPendingMessageNow({
      sessionId: SESSION,
      messageId: deploy.id,
      userId: USER,
    });
    const run = await runs.getAgentRun(runId);
    expect(run?.status).toBe('cancelled');
    expect(result.startedRunId).toBe(await activeRunId());
    expect(started.at(-1)?.userText).toBe('Deploy it now');
    expect(result.pending.paused).toBe(false);
    expect(result.pending.messages.map((message) => message.id)).toEqual([
      chart.id,
    ]);

    await finish(result.startedRunId!);
    expect(started.at(-1)?.userText).toBe('Add a chart');
  });
});

describe('pending message attachments', () => {
  it('are committed on send, released on edit or cancel, and become the run input', async () => {
    await updateAgentPreferences(USER, { messageMode: 'queue' });
    const runId = await startRun('Build a tracker');
    await db.insert(schema.agentAttachments).values(
      ['a1', 'a2'].map((id) => ({
        id,
        sessionId: SESSION,
        name: `${id}.txt`,
        contentType: 'text/plain',
        size: 3,
      })),
    );
    await pending.enqueuePendingMessage({
      sessionId: SESSION,
      userId: USER,
      ...MODEL,
      message: { content: text('See files'), attachmentIds: ['a1', 'a2'] },
    });
    const attachedAt = async (id: string) =>
      (
        await db.query.agentAttachments.findFirst({
          where: { id },
        })
      )?.attachedAt ?? null;
    expect(await attachedAt('a1')).not.toBeNull();
    // A committed attachment cannot be sent elsewhere.
    await expect(
      pending.enqueuePendingMessage({
        sessionId: SESSION,
        userId: USER,
        ...MODEL,
        message: { content: text('Again'), attachmentIds: ['a1'] },
      }),
    ).rejects.toMatchObject({ status: 409 });

    const [message] = (await tray()).messages;
    // An omitted field stays as it was.
    const edited = await pending.updatePendingMessage({
      sessionId: SESSION,
      messageId: message.id,
      message: { content: text('See these files') },
    });
    expect(edited.pending.messages[0]).toMatchObject({
      text: 'See these files',
      attachments: [{ id: 'a1' }, { id: 'a2' }],
    });
    await pending.updatePendingMessage({
      sessionId: SESSION,
      messageId: message.id,
      message: { attachmentIds: ['a1'] },
    });
    expect(await attachedAt('a2')).toBeNull();
    expect((await tray()).messages[0].text).toBe('See these files');
    await expect(
      pending.updatePendingMessage({
        sessionId: SESSION,
        messageId: message.id,
        message: { attachmentIds: ['a1', 'a2'] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pending.updatePendingMessage({
        sessionId: SESSION,
        messageId: message.id,
        message: { content: [], attachmentIds: [] },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await finish(runId);
    expect(started.at(-1)?.attachments.map((item) => item.id)).toEqual(['a1']);
  });

  it('releases attachments of a cancelled message', async () => {
    await startRun('Build a tracker');
    await db.insert(schema.agentAttachments).values({
      id: 'a1',
      sessionId: SESSION,
      name: 'a1.txt',
      contentType: 'text/plain',
      size: 3,
    });
    const { pending: before } = await pending.enqueuePendingMessage({
      sessionId: SESSION,
      userId: USER,
      ...MODEL,
      message: { content: text('See file'), attachmentIds: ['a1'] },
    });
    await pending.cancelPendingMessage({
      sessionId: SESSION,
      messageId: before.messages[0].id,
    });
    const row = await db.query.agentAttachments.findFirst({
      where: { id: 'a1' },
    });
    expect(row?.attachedAt).toBeNull();
    expect((await tray()).messages).toEqual([]);
  });
});

describe('retry', () => {
  it('returns steer messages injected into the failed run to the tray', async () => {
    const runId = await startRun('Build a tracker');
    await send('Use blue');
    const [claimed] = await runs.claimSteerMessages(RUNNER, runId);
    const session = await db.query.agentSessions.findFirst({
      where: { id: SESSION },
    });
    await finish(runId, 'failed', [
      ...(session!.messages as JsonValue[]),
      {
        role: 'user',
        content: [{ type: 'text', text: 'Use blue' }],
        steered: true,
        pendingMessageId: claimed.id,
      },
    ]);
    expect((await tray()).messages).toEqual([]);
    await runs.stopAgentAutoRetry(SESSION);

    const failed = await db.query.agentSessions.findFirst({
      where: { id: SESSION },
    });
    await runs.startAgentRun({
      sessionId: SESSION,
      retry: true,
      expectedSessionUpdatedAt: failed!.updatedAt.toISOString(),
      ...MODEL,
      userId: USER,
    });
    expect(started.at(-1)).toMatchObject({
      userText: 'Build a tracker',
      steerPending: true,
    });
    expect((await tray()).messages.map((message) => message.text)).toEqual([
      'Use blue',
    ]);
    const [restored] = await db
      .select()
      .from(schema.agentPendingMessages)
      .where(eq(schema.agentPendingMessages.sessionId, SESSION));
    expect(restored.mode).toBe('steer');
  });
});
