/**
 * Server-only: the CONTROL PLANE for agent runs.
 *
 * Execution happens in the separate Agent Runner service; this module owns
 * the database state machine (run rows, event log, leases), dispatches new
 * runs to a connected runner through the hub, ingests the runner's event
 * stream (deduped on `runnerSeq`), and fans events out to SSE subscribers.
 *
 * A run's lifecycle:
 *   startAgentRun → dispatch to runner (lease assigned)
 *   → runner streams `run.event`s (ask/tool/text/…; each renews the lease)
 *   → runner reports `run.finished` (messages persisted, terminal event)
 *   Cancel/answer/environment flow platform → runner over the same channel.
 *   A sweeper interrupts active runs whose lease expired (runner died).
 */
import { toUSVString } from 'node:util';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema, type DB, type TX } from '~/db';
import type { AgentRunStatus, JsonObject, JsonValue } from '~/db/schema';
import type { StopReason } from '@earendil-works/pi-ai';
import type {
  AgentRunStreamEvent,
  AgentStreamEvent,
  AskAnswer,
  AskQuestion,
  EnvVariableField,
} from '~agent/events';
import {
  formatAttachmentPrompt,
  type AgentAttachmentRef,
} from '~agent/attachments';
import {
  compactComposerInput,
  composerDisplayText,
  composerInputSchema,
  composerModelText,
  hasComposerReference,
  type AgentComposerContentPart,
  type ComposerInputPart,
} from '~agent/composer-content';
import {
  LEASE_SWEEP_INTERVAL_MS,
  RUN_LEASE_TTL_MS,
  envEntriesSchema,
  type EnvEntry,
  type RunModelConfig,
  type SendImage,
} from '~agent/protocol';
import {
  isSteeredUserMessage,
  nextUserTurn,
  parseUserTurn,
} from '~agent/user-turns';
import type { SteerMessage } from '~agent/protocol';
import { AppError } from '~server/errors';
import {
  AGENT_AUTO_RETRY_MAX_ATTEMPTS,
  AGENT_AUTO_RETRY_IDLE_POLL_MS,
  AGENT_AUTO_RETRY_STATUSES,
  agentAutoRetryDelayMs,
  shouldAutoRetry,
} from './agent-auto-retry';
import {
  parseRetryableAgentTurn,
  parseUserMessageInput,
  type RetryableAgentTurn,
} from './agent-retry';
import {
  claimSteerRows,
  effectivePendingStatus,
  hasClaimableSteer,
  hasPendingMessages,
  loadPendingRows,
  markPendingMessageInjected,
  pendingRowContent,
  releaseSettledClaims,
  setPendingPaused,
  settleRunPendingMessages,
  toSteerMessage,
} from './agent-pending-store';
import {
  connectedRunnerCount,
  listConnectedRunners,
  dispatchRun,
  sendRunAnswer,
  sendRunCancel,
  sendRunEnvAndWait,
  sendRunSteer,
  waitForRunFinished,
  RunNotStartedError,
} from './agent-runner/hub';

// PostgreSQL rejects NUL and unpaired surrogates, even inside JSON strings.
function storageSafeJson<T>(value: T): T {
  if (typeof value === 'string') {
    return toUSVString(value.replaceAll('\0', '\\u0000')) as T;
  }
  if (Array.isArray(value)) return value.map(storageSafeJson) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        storageSafeJson(key),
        storageSafeJson(item),
      ]),
    ) as T;
  }
  return value;
}

export type AgentRunInput =
  | {
      sessionId: string;
      retry: true;
      /** Revision of the session snapshot whose failure the user retried. */
      expectedSessionUpdatedAt: string;
      providerId: string;
      modelId: string;
      /** User who asked for the run (see `agentRuns.userId`). */
      userId?: string | null;
    }
  | {
      sessionId: string;
      retry: true;
      /** Platform-scheduled retry of this failed run (never client input). */
      autoRetryOfRunId: string;
      providerId: string;
      modelId: string;
    }
  | {
      sessionId: string;
      retry?: false;
      content: ComposerInputPart[];
      images?: SendImage[];
      attachmentIds?: string[];
      providerId: string;
      modelId: string;
      userId?: string | null;
      pendingMessageIds?: never;
    }
  | {
      sessionId: string;
      retry?: false;
      /**
       * Deliver these pending messages (server-side input only), combined in
       * send order. They are removed in the run's commit, and their
       * attachments, already committed to them, become this run's.
       */
      pendingMessageIds: string[];
      providerId: string;
      modelId: string;
      userId?: string | null;
      /**
       * Automatic delivery (not Send now): defers, under the session lock,
       * when delivery was paused or an automatic retry is scheduled.
       */
      automatic?: boolean;
    };

/** Another run is active in the session. */
export class ActiveRunConflictError extends AppError {
  constructor() {
    super('This chat already has a running Agent turn.', 409);
    this.name = 'ActiveRunConflictError';
  }
}

/** Automatic delivery must wait: delivery is paused or a retry is due. */
export class PendingDeliveryDeferredError extends AppError {
  constructor() {
    super('Pending messages wait for the session.', 409);
    this.name = 'PendingDeliveryDeferredError';
  }
}

/** The pending messages a run was asked to deliver changed meanwhile. */
export class PendingMessagesChangedError extends AppError {
  constructor() {
    super('The pending message changed. Try again.', 409);
    this.name = 'PendingMessagesChangedError';
  }
}

export type PendingAskPayload = {
  askId: string;
  questions: AskQuestion[];
};

type PendingAnswerPayload = {
  askId: string;
  answers: AskAnswer[];
};

export type PendingEnvRequestPayload = {
  requestId: string;
  reason: string;
  variables: EnvVariableField[];
};

export type ActiveAgentRun = {
  id: string;
  status: AgentRunStatus;
  /** Run creation time (ISO); the live work timer counts from here. */
  startedAt: string;
  /**
   * User turn the run answers (`~agent/user-turns`); null when the run
   * predates the binding and no transcript snapshot was available to derive it.
   */
  userTurn: number | null;
  pendingAsk: PendingAskPayload | null;
  answeredAskId?: string | null;
  pendingEnvRequest: PendingEnvRequestPayload | null;
};

/** Timing of the run that produced the reply to one user turn. */
export type SessionRunTiming = {
  id: string;
  status: AgentRunStatus;
  /** See `~agent/user-turns`. */
  userTurn: number;
  startedAt: string;
  /** Null while the run is active. */
  completedAt: string | null;
  /**
   * Why a failed or interrupted run ended. The transcript may not carry it:
   * an interrupted run (or a stopped one whose Runner never reported) has no
   * persisted reply, so history renders this notice instead.
   */
  error: string | null;
};

/**
 * The session's latest run failed and its turn can be replayed. `attempt` is
 * the consecutive failure streak; `nextRetryAt` is set while an automatic
 * retry is scheduled and null once it was stopped or the limit was reached.
 */
export type SessionRetryState = {
  runId: string;
  /** See `~agent/user-turns`. */
  userTurn: number;
  attempt: number;
  maxAttempts: number;
  nextRetryAt: string | null;
};

type Subscriber = (event: AgentRunStreamEvent) => void;

type AutoRetryScheduler = {
  timer?: ReturnType<typeof setTimeout>;
  /** Epoch ms the armed timer fires at. */
  wakeAt?: number;
  running: boolean;
  /** Earliest wake requested while a cycle was running. */
  pendingWake?: number;
};

type AgentRunsGlobal = typeof globalThis & {
  /** SSE subscribers per run (control plane fan-out). */
  __hatchAgentRunSubs__?: Map<string, Set<Subscriber>>;
  /** Per-run ingest chains: serialize event processing in arrival order. */
  __hatchAgentRunChains__?: Map<string, Promise<unknown>>;
  __hatchAgentRunSweeper__?: ReturnType<typeof setInterval>;
  __hatchAgentAutoRetryScheduler__?: AutoRetryScheduler;
};

export const ACTIVE_STATUSES: AgentRunStatus[] = ['running', 'blocked'];
const TERMINAL_STATUSES: AgentRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

function subscriberMap(): Map<string, Set<Subscriber>> {
  const g = globalThis as AgentRunsGlobal;
  g.__hatchAgentRunSubs__ ??= new Map();
  return g.__hatchAgentRunSubs__;
}

function chainMap(): Map<string, Promise<unknown>> {
  const g = globalThis as AgentRunsGlobal;
  g.__hatchAgentRunChains__ ??= new Map();
  return g.__hatchAgentRunChains__;
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** True while the run's runner lease is still valid. */
export function hasLiveLease(run: { leaseExpiresAt: Date | null }): boolean {
  return (
    run.leaseExpiresAt != null && run.leaseExpiresAt.getTime() > Date.now()
  );
}

function leaseDeadline(): Date {
  return new Date(Date.now() + RUN_LEASE_TTL_MS);
}

function deriveTitle(userText: string): string {
  const firstLine = userText.trim().split('\n')[0] ?? '';
  return firstLine.length > 48
    ? `${firstLine.slice(0, 48)}…`
    : firstLine || 'New chat';
}

function userMessage(
  userText: string,
  composerContent: AgentComposerContentPart[] = [],
  images: SendImage[] = [],
  attachments: AgentAttachmentRef[] = [],
): JsonObject {
  const content: JsonValue[] = [];
  const prompt = formatAttachmentPrompt(userText, attachments);
  if (prompt.trim()) content.push({ type: 'text', text: prompt });
  for (const image of images) {
    content.push({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
    });
  }
  return {
    role: 'user',
    content,
    ...(attachments.length > 0
      ? { attachments: attachments as unknown as JsonValue }
      : {}),
    ...(hasComposerReference(composerContent)
      ? { composerContent: composerContent as unknown as JsonValue }
      : {}),
  };
}

function asPendingAsk(value: JsonObject | null): PendingAskPayload | null {
  if (!value) return null;
  return value as unknown as PendingAskPayload;
}

function asPendingAnswer(
  value: JsonObject | null,
): PendingAnswerPayload | null {
  if (!value) return null;
  return value as unknown as PendingAnswerPayload;
}

function asPendingEnvRequest(
  value: JsonObject | null,
): PendingEnvRequestPayload | null {
  if (!value) return null;
  return value as unknown as PendingEnvRequestPayload;
}

function publish(runId: string, event: AgentRunStreamEvent): void {
  const set = subscriberMap().get(runId);
  if (!set) return;
  for (const subscriber of set) {
    subscriber(event);
  }
}

/**
 * Serialize work for one run onto a promise chain so runner events are
 * persisted in arrival order even though each WS message handler is async.
 */
function enqueueRunTask<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const chains = chainMap();
  const tail = chains.get(runId) ?? Promise.resolve();
  const result = tail.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(runId, settled);
  void settled.then(() => {
    if (chains.get(runId) === settled) chains.delete(runId);
  });
  return result;
}

/**
 * Append an event, allocating its `seq` as `max(seq)+1` for the run. A per-run
 * advisory lock (held to the end of the transaction) serializes concurrent
 * allocations across connections/processes. When `runnerSeq` is given, the
 * unique (run_id, runner_seq) index dedupes resends after a runner reconnect:
 * a duplicate inserts nothing and returns null.
 */
async function persistEvent(
  runId: string,
  event: AgentStreamEvent,
  runnerSeq?: number,
): Promise<AgentRunStreamEvent | null> {
  const safeEvent = storageSafeJson(event);
  const seq = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
    const rows = await tx.execute<{ seq: number }>(sql`
      insert into agent_run_events (id, run_id, seq, runner_seq, type, payload)
      select ${ulid().toLowerCase()}, ${runId},
             coalesce(max(seq), 0) + 1, ${runnerSeq ?? null},
             ${event.type}, ${safeEvent}::jsonb
      from agent_run_events where run_id = ${runId}
      on conflict (run_id, runner_seq) do nothing
      returning seq
    `);
    const inserted = (rows as unknown as { seq: number }[])[0];
    return inserted ? Number(inserted.seq) : null;
  });
  if (seq == null) return null;
  return { seq, event: safeEvent };
}

async function appendEvent(
  runId: string,
  event: AgentStreamEvent,
  runnerSeq?: number,
): Promise<AgentRunStreamEvent | null> {
  const stored = await persistEvent(runId, event, runnerSeq);
  if (stored) publish(runId, stored);
  return stored;
}

type FinishedRun = { finished: boolean; autoRetryAt: Date | null };

/**
 * Make an active run terminal and record its failure streak, scheduling an
 * automatic retry when it failed. Callers that already hold the session row
 * lock pass their transaction; the lock order is always session, then run.
 */
async function finishRunInTx(
  tx: TX,
  runId: string,
  status: AgentRunStatus,
  error?: string,
  options: FinishOptions = {},
): Promise<FinishedRun> {
  const now = new Date();
  const [row] = await tx
    .update(schema.agentRuns)
    .set({
      status,
      error: error ?? null,
      pendingAsk: null,
      pendingAnswer: null,
      pendingEnvRequest: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.agentRuns.id, runId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
      ),
    )
    .returning({ sessionId: schema.agentRuns.sessionId });
  if (!row) return { finished: false, autoRetryAt: null };

  // Only one run per session is active, so the previous run is terminal
  // and its streak is final. ULIDs order runs by creation.
  const previous = await tx.query.agentRuns.findFirst({
    where: { sessionId: row.sessionId, id: { lt: runId } },
    orderBy: { id: 'desc' },
    columns: { failureStreak: true },
  });
  const previousStreak = previous?.failureStreak ?? 0;
  const failed = (AGENT_AUTO_RETRY_STATUSES as readonly string[]).includes(
    status,
  );
  const failureStreak =
    status === 'completed' ? 0 : failed ? previousStreak + 1 : previousStreak;
  const autoRetryAt =
    failed && shouldAutoRetry(failureStreak)
      ? new Date(now.getTime() + agentAutoRetryDelayMs(failureStreak))
      : null;
  if (failureStreak !== 0 || autoRetryAt) {
    await tx
      .update(schema.agentRuns)
      .set({ failureStreak, autoRetryAt })
      .where(eq(schema.agentRuns.id, runId));
  }
  // Messages sent while the run worked stop being delivered automatically
  // when the user stopped it or it failed for good (no retry follows).
  const pause =
    status === 'cancelled'
      ? options.pausePending !== false
      : status !== 'completed' && !autoRetryAt;
  if (pause && (await hasPendingMessages(tx, row.sessionId))) {
    await setPendingPaused(tx, row.sessionId, true);
  }
  return { finished: true, autoRetryAt };
}

type FinishOptions = {
  /** A user Stop pauses pending messages; Send now does not. */
  pausePending?: boolean;
};

/** Lock the run's session, then finish the run (session-then-run order). */
async function finishRun(
  runId: string,
  status: AgentRunStatus,
  error?: string,
  options: FinishOptions = {},
): Promise<boolean> {
  const owner = await db.query.agentRuns.findFirst({
    where: { id: runId },
    columns: { sessionId: true },
  });
  if (!owner) return false;
  const result = await db.transaction(async (tx) => {
    await tx
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, owner.sessionId))
      .for('update');
    return finishRunInTx(tx, runId, status, error, options);
  });
  if (result.autoRetryAt) wakeAgentAutoRetryScheduler(result.autoRetryAt);
  if (result.finished) kickPendingDispatch(owner.sessionId);
  return result.finished;
}

function isActiveRunConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const pgError =
    'cause' in error && error.cause && typeof error.cause === 'object'
      ? error.cause
      : error;
  const code = (pgError as { code?: unknown }).code;
  const constraint = (pgError as { constraint?: unknown }).constraint;
  return code === '23505' && constraint === 'agent_runs_active_session_idx';
}

export async function getActiveAgentRun(
  sessionId: string,
  executor: DB | TX = db,
): Promise<ActiveAgentRun | null> {
  const row = await executor.query.agentRuns.findFirst({
    where: { sessionId, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.createdAt.toISOString(),
    userTurn: parseUserTurn(row.input.userTurn),
    pendingAsk: asPendingAsk(row.pendingAsk ?? null),
    answeredAskId: asPendingAnswer(row.pendingAnswer ?? null)?.askId ?? null,
    pendingEnvRequest: asPendingEnvRequest(row.pendingEnvRequest ?? null),
  };
}

/**
 * Timing for the newest run of each user turn in a session.
 *
 * Retry replays a failed turn at the same user turn, so older runs for that
 * turn no longer describe the reply in the transcript. Runs created before
 * the binding existed have no user turn and are omitted rather than guessed.
 */
export async function listSessionRunTimings(
  sessionId: string,
  executor: DB | TX = db,
): Promise<SessionRunTiming[]> {
  const rows = await executor
    .select({
      id: schema.agentRuns.id,
      status: schema.agentRuns.status,
      userTurn: sql<string | null>`case
        when jsonb_typeof(${schema.agentRuns.input} -> 'userTurn') = 'number'
        then ${schema.agentRuns.input} ->> 'userTurn' end`,
      createdAt: schema.agentRuns.createdAt,
      completedAt: schema.agentRuns.completedAt,
      error: schema.agentRuns.error,
    })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.sessionId, sessionId))
    .orderBy(asc(schema.agentRuns.createdAt), asc(schema.agentRuns.id));
  const byTurn = new Map<number, SessionRunTiming>();
  for (const row of rows) {
    const userTurn = parseUserTurn(row.userTurn);
    if (userTurn === null) continue;
    byTurn.set(userTurn, {
      id: row.id,
      status: row.status,
      userTurn,
      startedAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      error: row.error,
    });
  }
  return [...byTurn.values()].sort((a, b) => a.userTurn - b.userTurn);
}

export async function getAgentRun(runId: string) {
  return db.query.agentRuns.findFirst({
    where: { id: runId },
  });
}

export async function listRunEventsAfter(
  runId: string,
  afterSeq: number,
  limit = 1000,
): Promise<AgentRunStreamEvent[]> {
  // Bound each query: a long or noisy run can persist thousands of events, so
  // callers page through with `limit` instead of loading the whole tail into
  // memory at once (see the SSE replay loop).
  const rows = await db.query.agentRunEvents.findMany({
    where: { runId, seq: { gt: afterSeq } },
    orderBy: { seq: 'asc' },
    limit,
  });
  return rows.map((row) => ({
    seq: row.seq,
    event: row.payload as unknown as AgentStreamEvent,
  }));
}

export function subscribeToAgentRun(
  runId: string,
  subscriber: Subscriber,
): () => void {
  const map = subscriberMap();
  const set = map.get(runId) ?? new Set<Subscriber>();
  map.set(runId, set);
  set.add(subscriber);
  return () => {
    set.delete(subscriber);
    if (set.size === 0 && map.get(runId) === set) map.delete(runId);
  };
}

/** ================== model resolution ================== */

/**
 * Resolve the model for a run into the self-contained config the runner
 * needs (including the provider API key, scoped to just this provider).
 */
async function resolveRunModelConfig(
  providerId: string,
  modelId: string,
): Promise<RunModelConfig> {
  const provider = await db.query.agentProviders.findFirst({
    where: { id: providerId, enabled: true },
  });
  if (!provider) {
    throw new AppError('The selected Agent model is unavailable.', 409);
  }

  const model = await db.query.agentModels.findFirst({
    where: { providerId, modelId, enabled: true },
  });
  if (!model) {
    throw new AppError('The selected Agent model is unavailable.', 409);
  }

  return {
    providerId: provider.id,
    providerName: provider.name,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: {
      id: model.modelId,
      name: model.name,
      reasoning: model.reasoning,
      // Keep the wire field for existing Runners; it is not configurable.
      input: ['text', 'image'],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    },
  };
}

/** ================== start / dispatch ================== */

/** Reject a provider/model pair no run could start with. */
export async function assertAgentModelAvailable(
  providerId: string,
  modelId: string,
): Promise<void> {
  await resolveRunModelConfig(providerId, modelId);
}

/** Images and attachments one message (and so one delivered run) carries. */
const MAX_PENDING_RUN_FILES = 6;

/** Several pending messages delivered as one run read as separate paragraphs. */
export function combinePendingContent(
  contents: ComposerInputPart[][],
): ComposerInputPart[] {
  const parts: ComposerInputPart[] = [];
  contents.forEach((content, index) => {
    if (index > 0) parts.push({ type: 'text', text: '\n\n' });
    parts.push(...content);
  });
  return compactComposerInput(parts);
}

const NO_RETRYABLE_TURN = 'There is no failed Agent turn to retry.';

type RetryTarget = {
  run: typeof schema.agentRuns.$inferSelect;
  userTurn: number;
  turn: RetryableAgentTurn;
};

/**
 * The session's failed turn, when its latest run failed or was interrupted
 * and that run's user message is still the transcript's last user message.
 */
async function findRetryTarget(
  executor: DB | TX,
  sessionId: string,
  messages: JsonValue[],
): Promise<RetryTarget | null> {
  const run = await executor.query.agentRuns.findFirst({
    where: { sessionId },
    orderBy: { id: 'desc' },
  });
  if (
    !run ||
    !(AGENT_AUTO_RETRY_STATUSES as readonly string[]).includes(run.status)
  ) {
    return null;
  }
  // A run that predates user-turn binding answered the last user message.
  const userTurn =
    parseUserTurn(run.input.userTurn) ?? nextUserTurn(messages) - 1;
  if (userTurn < 0) return null;
  const turn = parseRetryableAgentTurn(messages, userTurn);
  return turn ? { run, userTurn, turn } : null;
}

/** Retry state for a session snapshot (see `SessionRetryState`). */
export async function getSessionRetryState(
  sessionId: string,
  messages: JsonValue[],
  executor: DB | TX = db,
): Promise<SessionRetryState | null> {
  const target = await findRetryTarget(executor, sessionId, messages);
  if (!target) return null;
  return {
    runId: target.run.id,
    userTurn: target.userTurn,
    attempt: target.run.failureStreak,
    maxAttempts: AGENT_AUTO_RETRY_MAX_ATTEMPTS,
    nextRetryAt: target.run.autoRetryAt?.toISOString() ?? null,
  };
}

export async function startAgentRun(input: AgentRunInput): Promise<{
  runId: string;
  startedAt: string;
}> {
  const sessionRow = await db.query.agentSessions.findFirst({
    where: { id: input.sessionId },
  });
  if (!sessionRow) throw new AppError('Session not found.', 404);

  const activeRun = await getActiveAgentRun(input.sessionId);
  if (activeRun) {
    throw new ActiveRunConflictError();
  }

  const autoRetryOfRunId =
    input.retry === true && 'autoRetryOfRunId' in input
      ? input.autoRetryOfRunId
      : null;
  if (input.retry === true) {
    if (
      'expectedSessionUpdatedAt' in input &&
      sessionRow.updatedAt.toISOString() !== input.expectedSessionUpdatedAt
    ) {
      throw new AppError(NO_RETRYABLE_TURN, 409);
    }
    const initialRetry = await findRetryTarget(
      db,
      input.sessionId,
      (sessionRow.messages ?? []) as JsonValue[],
    );
    if (
      !initialRetry ||
      (autoRetryOfRunId !== null && initialRetry.run.id !== autoRetryOfRunId)
    ) {
      throw new AppError(NO_RETRYABLE_TURN, 409);
    }
  }

  const model = await resolveRunModelConfig(input.providerId, input.modelId);

  // An automatic retry still creates its run without a Runner: the dispatch
  // failure below counts as another consecutive failure and backs off again,
  // instead of silently dropping the schedule.
  // Automatic delivery waits for the Runner owning the chat's workspace
  // instead of consuming the messages into a run that cannot be dispatched;
  // that Runner's return delivers them (see deliverPendingAfterRunnerReady).
  if ('automatic' in input && input.automatic === true) {
    const affinity = await getSessionWorkspaceAffinity(input.sessionId);
    if (
      affinity.runnerId !== null &&
      !listConnectedRunners().some(
        (runner) => runner.runnerId === affinity.runnerId,
      )
    ) {
      throw new AppError(
        'The Agent Runner that owns this chat workspace is unavailable.',
        503,
      );
    }
  }
  if (autoRetryOfRunId === null && connectedRunnerCount() === 0) {
    throw new AppError(
      'No Agent Runner is connected. Start the agent-runner service, then retry.',
      503,
    );
  }

  type PreparedRun = {
    run: typeof schema.agentRuns.$inferSelect;
    /** Pending rows an automatic delivery consumed, to restore on failure. */
    consumed: ConsumedDelivery | null;
    baseMessages: JsonValue[];
    userText: string;
    composerContent: AgentComposerContentPart[];
    images: SendImage[];
    attachments: AgentAttachmentRef[];
  };
  let prepared: PreparedRun;
  try {
    prepared = await db.transaction(async (tx) => {
      // Serialize starts for this exact session, then re-read every piece of
      // transcript state used below. A request may have waited on model or
      // runner I/O after its initial validation; using that old snapshot here
      // could replay a turn that a newer run had already completed.
      const [lockedSession] = await tx
        .select()
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, input.sessionId))
        .for('update');
      if (!lockedSession) throw new AppError('Session not found.', 404);

      const [lockedActiveRun] = await tx
        .select({ id: schema.agentRuns.id })
        .from(schema.agentRuns)
        .where(
          and(
            eq(schema.agentRuns.sessionId, input.sessionId),
            inArray(schema.agentRuns.status, ACTIVE_STATUSES),
          ),
        )
        .limit(1);
      if (lockedActiveRun) {
        throw new ActiveRunConflictError();
      }
      const automatic = 'automatic' in input && input.automatic === true;
      if (automatic) {
        // Re-read under the lock: a Stop or a failure scheduling a retry can
        // commit after the dispatcher's unlocked checks.
        const retrying = await tx.query.agentRuns.findFirst({
          where: {
            sessionId: input.sessionId,
            autoRetryAt: { isNotNull: true },
          },
          columns: { id: true },
        });
        if (lockedSession.pendingPaused || retrying) {
          throw new PendingDeliveryDeferredError();
        }
      }
      // No run is active, so no older run can deliver what it claimed.
      await releaseSettledClaims(tx, input.sessionId);

      if (
        input.retry === true &&
        'expectedSessionUpdatedAt' in input &&
        lockedSession.updatedAt.toISOString() !== input.expectedSessionUpdatedAt
      ) {
        throw new AppError(NO_RETRYABLE_TURN, 409);
      }

      const sessionMessages = (lockedSession.messages ?? []) as JsonValue[];
      let baseMessages: JsonValue[];
      let userText: string;
      let displayText: string;
      let composerContent: AgentComposerContentPart[];
      let images: SendImage[];
      let requestedAttachmentIds: string[];
      let isRetry = false;
      // Attachments already committed to the pending messages this run takes.
      const preattachedIds = new Set<string>();
      let consumed: PreparedRun['consumed'] = null;
      let userId: string | null =
        input.retry === true && 'autoRetryOfRunId' in input
          ? null
          : (input.userId ?? null);
      if (input.retry === true) {
        const target = await findRetryTarget(
          tx,
          input.sessionId,
          sessionMessages,
        );
        if (!target) throw new AppError(NO_RETRYABLE_TURN, 409);
        if (autoRetryOfRunId !== null) {
          userId = target.run.userId;
          // Claim the schedule in the same commit as the replacement run, so
          // a stop, a newer run, or a concurrent scheduler pass wins cleanly.
          const claimed = await tx
            .update(schema.agentRuns)
            .set({ autoRetryAt: null })
            .where(
              and(
                eq(schema.agentRuns.id, autoRetryOfRunId),
                isNotNull(schema.agentRuns.autoRetryAt),
              ),
            )
            .returning({ id: schema.agentRuns.id });
          if (claimed.length === 0 || target.run.id !== autoRetryOfRunId) {
            throw new AppError(NO_RETRYABLE_TURN, 409);
          }
        }
        const retry = target.turn;
        baseMessages = retry.baseMessages;
        userText = retry.userText;
        composerContent = retry.composerContent;
        displayText =
          composerContent.length > 0
            ? composerDisplayText(composerContent)
            : userText;
        images = retry.images;
        requestedAttachmentIds = retry.attachments.map(
          (attachment) => attachment.id,
        );
        isRetry = true;
        // Steer messages injected into the failed run go back to the tray:
        // the replay starts from the turn's own message, and injects them
        // again at its first tool-call boundary.
        const steered = sessionMessages
          .slice(retry.baseMessages.length + 1)
          .filter(isSteeredUserMessage);
        for (const message of steered) {
          const restored = parseUserMessageInput(message);
          if (!restored) continue;
          // Keep the original id: rows are ordered by id, so the restored
          // message stays ahead of steer messages sent after it.
          const originalId = (message as { pendingMessageId?: unknown })
            .pendingMessageId;
          await tx
            .insert(schema.agentPendingMessages)
            .values({
              ...(typeof originalId === 'string' && originalId.length > 0
                ? { id: originalId }
                : {}),
              sessionId: input.sessionId,
              userId,
              mode: 'steer',
              content: (restored.composerContent.length > 0
                ? restored.composerContent
                : [{ type: 'text', text: restored.userText }]) as JsonValue[],
              images: restored.images as unknown as JsonValue[],
              attachments: restored.attachments as unknown as JsonValue[],
              providerId: model.providerId,
              modelId: model.model.id,
            })
            .onConflictDoNothing();
        }
      } else if ('pendingMessageIds' in input && input.pendingMessageIds) {
        const rows = await loadPendingRows(tx, input.sessionId, {
          forUpdate: true,
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        const now = Date.now();
        const taken = input.pendingMessageIds.map((id) => {
          const row = byId.get(id);
          const status = row
            ? effectivePendingStatus(row, row.claimedRunStatus, now)
            : null;
          if (
            !row ||
            (status !== 'pending' && status !== 'sending') ||
            row.providerId !== input.providerId ||
            row.modelId !== input.modelId
          ) {
            throw new PendingMessagesChangedError();
          }
          return pendingRowContent(row);
        });
        if (taken.length === 0) throw new PendingMessagesChangedError();
        if ('automatic' in input && input.automatic === true) {
          consumed = {
            rows: input.pendingMessageIds.map((id) => {
              const { claimedRunStatus: _status, ...row } = byId.get(id)!;
              return { ...row, status: 'pending' as const, claimedRunId: null };
            }),
            before: {
              title: lockedSession.title,
              providerId: lockedSession.providerId,
              modelId: lockedSession.modelId,
            },
            // Filled in once this start has set them (below).
            after: { title: '', providerId: null, modelId: null },
          };
        }
        const content = combinePendingContent(taken.map((row) => row.content));
        baseMessages = sessionMessages;
        userText = composerModelText(content);
        displayText = composerDisplayText(content);
        composerContent = hasComposerReference(content) ? content : [];
        images = taken.flatMap((row) => row.images);
        requestedAttachmentIds = taken.flatMap((row) =>
          row.attachments.map((attachment) => attachment.id),
        );
        for (const id of requestedAttachmentIds) preattachedIds.add(id);
        await tx
          .delete(schema.agentPendingMessages)
          .where(
            and(
              eq(schema.agentPendingMessages.sessionId, input.sessionId),
              inArray(schema.agentPendingMessages.id, input.pendingMessageIds),
            ),
          );
      } else {
        baseMessages = sessionMessages;
        // Resource mentions are user-provided context, not capabilities. Keep
        // the selection-time snapshot so deleting or renaming a resource
        // cannot invalidate an already-written draft.
        userText = composerModelText(input.content);
        displayText = composerDisplayText(input.content);
        composerContent = hasComposerReference(input.content)
          ? input.content
          : [];
        images = input.images ?? [];
        requestedAttachmentIds = input.attachmentIds ?? [];
      }

      // Any new run (a message, a manual retry, or this automatic one)
      // supersedes every pending automatic retry in the session.
      await tx
        .update(schema.agentRuns)
        .set({ autoRetryAt: null })
        .where(
          and(
            eq(schema.agentRuns.sessionId, input.sessionId),
            isNotNull(schema.agentRuns.autoRetryAt),
          ),
        );

      const attachmentIds = [...new Set(requestedAttachmentIds)];
      const attachmentRows =
        attachmentIds.length > 0
          ? await tx
              .select()
              .from(schema.agentAttachments)
              .where(
                and(
                  eq(schema.agentAttachments.sessionId, input.sessionId),
                  inArray(schema.agentAttachments.id, attachmentIds),
                ),
              )
              .for('update')
          : [];
      if (attachmentRows.length !== attachmentIds.length) {
        throw new AppError('One or more attachments were not found.', 404);
      }
      if (
        !isRetry &&
        attachmentRows.some(
          (row) => row.attachedAt != null && !preattachedIds.has(row.id),
        )
      ) {
        throw new AppError(
          'One or more attachments are already attached.',
          409,
        );
      }
      const attachmentById = new Map(
        attachmentRows.map((row) => [row.id, row]),
      );
      const attachments = attachmentIds.map((id) => {
        const row = attachmentById.get(id)!;
        return {
          id: row.id,
          name: row.name,
          mimeType: row.contentType,
          size: row.size,
        } satisfies AgentAttachmentRef;
      });

      const title =
        lockedSession.title && lockedSession.title !== 'New chat'
          ? lockedSession.title
          : deriveTitle(displayText);
      const [inserted] = await tx
        .insert(schema.agentRuns)
        .values({
          sessionId: input.sessionId,
          userId,
          providerId: model.providerId,
          modelId: model.model.id,
          status: 'running',
          // Covers the dispatch window; the accepting runner renews from here.
          leaseExpiresAt: leaseDeadline(),
          // Same clock as `completedAt` (finishRun), so their difference is
          // the run's real duration.
          createdAt: new Date(),
          // Store image metadata, not the base64 payloads — those already
          // live in the persisted session message, and duplicating them here
          // bloated the row. `userTurn` binds the run to the user message
          // appended below (see `~agent/user-turns`); the rest is diagnostics.
          input: {
            userText,
            composerContent,
            images: images.map((image) => ({ mimeType: image.mimeType })),
            attachments,
            userTurn: nextUserTurn(baseMessages),
          },
        })
        .returning();

      // Keep run creation and transcript replacement in one commit. In
      // particular, a retry must never delete the failed turn unless the new
      // run row was created successfully.
      await tx
        .update(schema.agentSessions)
        .set({
          messages: [
            ...baseMessages,
            userMessage(userText, composerContent, images, attachments),
          ],
          title,
          providerId: model.providerId,
          modelId: model.model.id,
        })
        .where(eq(schema.agentSessions.id, input.sessionId));

      // A run the user started (rather than an automatic retry) resumes
      // delivery of messages that were paused.
      if (autoRetryOfRunId === null) {
        await setPendingPaused(tx, input.sessionId, false);
      }

      if (!isRetry && attachmentIds.length > 0) {
        await tx
          .update(schema.agentAttachments)
          .set({ attachedAt: new Date() })
          .where(
            and(
              eq(schema.agentAttachments.sessionId, input.sessionId),
              inArray(schema.agentAttachments.id, attachmentIds),
              isNull(schema.agentAttachments.attachedAt),
            ),
          );
      }

      if (consumed) {
        consumed.after = {
          title,
          providerId: model.providerId,
          modelId: model.model.id,
        };
      }
      return {
        run: inserted,
        consumed,
        baseMessages,
        userText,
        composerContent,
        images,
        attachments,
      };
    });
  } catch (error) {
    if (isActiveRunConflict(error)) {
      throw new ActiveRunConflictError();
    }
    throw error;
  }
  const {
    run,
    consumed,
    baseMessages,
    userText,
    composerContent,
    images,
    attachments,
  } = prepared;

  let dispatchedWithoutSteer = false;
  try {
    const affinity = await getSessionWorkspaceAffinity(input.sessionId);
    const steerPending = await hasClaimableSteer(db, input.sessionId);
    await dispatchRun(
      {
        runId: run.id,
        sessionId: input.sessionId,
        userText,
        composerContent,
        images,
        attachments,
        priorMessages: baseMessages,
        model,
        ...(steerPending ? { steerPending } : {}),
      },
      {
        ownerRunnerId: affinity.runnerId,
        assign: (runnerId) =>
          assignRunToRunner(run.id, input.sessionId, runnerId),
        finalize: (runnerId) =>
          finalizeRunWorkspaceAffinity(run.id, runnerId, input.sessionId),
      },
    );
    dispatchedWithoutSteer = !steerPending;
  } catch (error) {
    // Dispatch failed (runner vanished between the check and the send, or
    // never accepted). Fail the run gracefully: the client's SSE connection
    // replays the error event instead of hanging on "Thinking…". Serialized
    // on the per-run chain against any events the runner did manage to send.
    const message =
      error instanceof Error ? error.message : 'Failed to dispatch the run.';
    // An automatic delivery that no Runner took puts its messages back in
    // the tray (still editable) instead of leaving them in a failed turn.
    if (
      consumed &&
      error instanceof RunNotStartedError &&
      (await undoUndispatchedDelivery(run.id, consumed, baseMessages))
    ) {
      throw new AppError(
        'The Agent Runner that owns this chat workspace is unavailable.',
        503,
      );
    }
    await enqueueRunTask(run.id, async () => {
      if (await finishRun(run.id, 'failed', message)) {
        await appendEvent(run.id, { type: 'error', message });
      }
    });
  }

  // A steer message sent while the run was being dispatched found no Runner
  // to notify; tell the accepting one now.
  if (dispatchedWithoutSteer) {
    try {
      if (await hasClaimableSteer(db, input.sessionId)) {
        await notifyActiveRunOfSteer(input.sessionId);
      }
    } catch (error) {
      console.error('[agent-runs] steer hint after dispatch failed:', error);
    }
  }

  return { runId: run.id, startedAt: run.createdAt.toISOString() };
}

type SessionSettings = {
  title: string;
  providerId: string | null;
  modelId: string | null;
};

/** Pending rows an automatic delivery consumed, to restore if it fails. */
type ConsumedDelivery = {
  rows: (typeof schema.agentPendingMessages.$inferSelect)[];
  /** Session settings before this start, and the ones it set. */
  before: SessionSettings;
  after: SessionSettings;
};

/**
 * Reverse an automatic delivery whose run definitely never started: remove the run
 * and its prompt, and return the messages to the tray. Only when nothing
 * happened since (the run is still unaccepted-active, no newer run, the
 * transcript unchanged); otherwise the caller fails the run as usual.
 */
async function undoUndispatchedDelivery(
  runId: string,
  consumed: ConsumedDelivery,
  baseMessages: JsonValue[],
): Promise<boolean> {
  const run = await getAgentRun(runId);
  if (!run) return false;
  return enqueueRunTask(runId, () =>
    db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          messages: schema.agentSessions.messages,
          title: schema.agentSessions.title,
          providerId: schema.agentSessions.providerId,
          modelId: schema.agentSessions.modelId,
        })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, run.sessionId))
        .for('update');
      const [current] = await tx
        .select({ status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, runId))
        .for('update');
      const newer = await tx.query.agentRuns.findFirst({
        where: { sessionId: run.sessionId, id: { gt: runId } },
        columns: { id: true },
      });
      const events = await tx.query.agentRunEvents.findFirst({
        where: { runId },
        columns: { id: true },
      });
      if (
        !session ||
        !current ||
        !ACTIVE_STATUSES.includes(current.status) ||
        newer ||
        events ||
        session.messages.length !== baseMessages.length + 1
      ) {
        return false;
      }
      await tx.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      await tx
        .update(schema.agentSessions)
        .set({
          messages: baseMessages,
          // Restore only what this start set; keep a rename or model
          // change made meanwhile.
          ...(session.title === consumed.after.title
            ? { title: consumed.before.title }
            : {}),
          ...(session.providerId === consumed.after.providerId &&
          session.modelId === consumed.after.modelId
            ? {
                providerId: consumed.before.providerId,
                modelId: consumed.before.modelId,
              }
            : {}),
        })
        .where(eq(schema.agentSessions.id, run.sessionId));
      await tx
        .insert(schema.agentPendingMessages)
        .values(consumed.rows)
        .onConflictDoNothing();
      return true;
    }),
  );
}

/** ================== hub callbacks (runner lifecycle) ================== */

export type SessionWorkspaceAffinity =
  | { state: 'uninitialized'; runnerId: null }
  | { state: 'claimed'; runnerId: string };

/** Persistent ownership state for one session's Runner-local workspace. */
export async function getSessionWorkspaceAffinity(
  sessionId: string,
): Promise<SessionWorkspaceAffinity> {
  const session = await db.query.agentSessions.findFirst({
    where: { id: sessionId },
    columns: { workspaceAffinityState: true, workspaceRunnerId: true },
  });
  if (!session) throw new Error('Agent session no longer exists.');
  if (
    session.workspaceAffinityState === 'claimed' &&
    session.workspaceRunnerId != null
  ) {
    return { state: 'claimed', runnerId: session.workspaceRunnerId };
  }
  if (
    session.workspaceAffinityState === 'uninitialized' &&
    session.workspaceRunnerId == null
  ) {
    return { state: 'uninitialized', runnerId: null };
  }
  throw new Error('Agent session workspace affinity is inconsistent.');
}

/**
 * Provisionally assign an active run to a Runner. Session affinity is not
 * changed here: only an exact `run.accepted` (or a valid event that raced it)
 * proves that the selected connection created or opened the workspace.
 */
export async function assignRunToRunner(
  runId: string,
  sessionId: string,
  runnerId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        workspaceAffinityState: schema.agentSessions.workspaceAffinityState,
        workspaceRunnerId: schema.agentSessions.workspaceRunnerId,
      })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .for('update');
    if (!session) throw new Error('Agent session no longer exists.');
    if (
      session.workspaceAffinityState === 'claimed' &&
      session.workspaceRunnerId !== runnerId
    ) {
      throw new Error('Agent session workspace belongs to another Runner.');
    }
    if (
      (session.workspaceAffinityState === 'claimed') !==
      (session.workspaceRunnerId != null)
    ) {
      throw new Error('Agent session workspace affinity is inconsistent.');
    }

    const assigned = await tx
      .update(schema.agentRuns)
      .set({ runnerId, leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          eq(schema.agentRuns.sessionId, sessionId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      )
      .returning({ id: schema.agentRuns.id });
    if (assigned.length === 0) {
      throw new Error('Agent run is no longer active.');
    }
  });
}

/**
 * Commit workspace affinity after the assigned Runner proves it accepted the
 * run. Idempotent for later events from the same owner; rejects stale peers.
 */
export async function finalizeRunWorkspaceAffinity(
  runId: string,
  runnerId: string,
  expectedSessionId?: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    // Lock the session before the run, like every other session/run
    // transaction, so this cannot deadlock with a run start. A run's session
    // never changes, so the unlocked read only finds which session to lock.
    const owner = await tx.query.agentRuns.findFirst({
      where: { id: runId },
      columns: { sessionId: true },
    });
    if (!owner) {
      throw new Error('Agent run is no longer assigned to this Runner.');
    }
    const [session] = await tx
      .select({
        workspaceAffinityState: schema.agentSessions.workspaceAffinityState,
        workspaceRunnerId: schema.agentSessions.workspaceRunnerId,
      })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, owner.sessionId))
      .for('update');
    if (!session) throw new Error('Agent session no longer exists.');

    const [run] = await tx
      .select({
        sessionId: schema.agentRuns.sessionId,
        runnerId: schema.agentRuns.runnerId,
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .for('update');
    if (
      !run ||
      run.runnerId !== runnerId ||
      (expectedSessionId != null && run.sessionId !== expectedSessionId)
    ) {
      throw new Error('Agent run is no longer assigned to this Runner.');
    }

    if (session.workspaceAffinityState === 'claimed') {
      if (session.workspaceRunnerId !== runnerId) {
        throw new Error('Agent session workspace belongs to another Runner.');
      }
      return run.sessionId;
    }
    if (session.workspaceRunnerId != null) {
      throw new Error('Agent session workspace affinity is inconsistent.');
    }

    await tx
      .update(schema.agentSessions)
      .set({ workspaceAffinityState: 'claimed', workspaceRunnerId: runnerId })
      .where(eq(schema.agentSessions.id, run.sessionId));
    return run.sessionId;
  });
}

/** Heartbeat: extend the lease of every active run owned by this runner. */
export async function renewRunnerLeases(runnerId: string): Promise<void> {
  await db
    .update(schema.agentRuns)
    .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentRuns.runnerId, runnerId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
      ),
    );
}

export type RunnerReconciliation = {
  /**
   * Runs the runner should keep reporting on: still-owned active runs (keep
   * executing, resend outbound queues) AND owned runs that went terminal on
   * the platform while the runner was away — those still hold an unacked
   * final report whose resend persists the partial transcript and repairs a
   * missing terminal stream event (crash between finishRun and appendEvent).
   */
  resumed: string[];
  /** Runs this runner does not own (anymore): abort + discard locally. */
  stale: string[];
  /** Answers submitted while the runner was offline, to deliver now. */
  pendingAnswers: { runId: string; askId: string; answers: AskAnswer[] }[];
};

/**
 * Reconcile a (re)connecting runner's claimed active runs against the
 * database: runs it still owns get their lease renewed and resume; runs the
 * DB says it owns but it no longer claims (runner restarted and lost its
 * memory) are interrupted so their sessions unblock.
 */
export async function reconcileRunnerRuns(
  runnerId: string,
  claimedRunIds: string[],
): Promise<RunnerReconciliation> {
  const resumed: string[] = [];
  const stale: string[] = [];
  const pendingAnswers: RunnerReconciliation['pendingAnswers'] = [];
  const claimed = new Set(claimedRunIds);

  for (const runId of claimedRunIds) {
    const run = await getAgentRun(runId);
    if (!run || run.runnerId !== runnerId) {
      // Unknown or reassigned: this runner's copy must never report again.
      stale.push(runId);
      continue;
    }
    const terminal = isTerminalAgentRunStatus(run.status);
    if (!terminal && hasLiveLease(run)) {
      resumed.push(runId);
      const pendingAnswer = asPendingAnswer(run.pendingAnswer ?? null);
      if (pendingAnswer) {
        pendingAnswers.push({
          runId,
          askId: pendingAnswer.askId,
          answers: pendingAnswer.answers,
        });
      }
      continue;
    }
    if (!terminal) {
      // The claim is real but the lease lapsed: the run is past the grace
      // window and the sweeper/SSE path may already have raced to kill it.
      // Resuming would make the outcome depend on who runs first, so
      // enforce the lease contract deterministically instead.
      await interruptAgentRun(
        runId,
        'Agent run was interrupted because its Agent Runner stayed ' +
          'disconnected past the lease window.',
      );
    }
    // Owned but (now) terminal: the runner only claims runs it has not had
    // a finish ack for, so let it resend its final report instead of
    // discarding it — completeRunFromRunner persists the partial transcript
    // and repairs a missing done/cancelled/error stream event, then the
    // finish ack clears the runner's buffer. Any stream events it resends
    // first are ingested as stale (terminal status) and answered with
    // run.cancel, so a still-executing turn also winds down here.
    resumed.push(runId);
  }

  if (resumed.length > 0) {
    // Only truly active runs get a fresh lease; terminal runs resumed for
    // their final report must not resurface in lease bookkeeping.
    await db
      .update(schema.agentRuns)
      .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
      .where(
        and(
          inArray(schema.agentRuns.id, resumed),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  }

  const owned = await db.query.agentRuns.findMany({
    where: { runnerId, status: { in: ACTIVE_STATUSES } },
  });
  for (const run of owned) {
    if (!claimed.has(run.id)) {
      await interruptAgentRun(
        run.id,
        'Agent run was interrupted because the Agent Runner restarted.',
      );
    }
  }

  return { resumed, stale, pendingAnswers };
}

export type IngestResult =
  | { status: 'ok'; sessionId: string }
  | { status: 'stale' };

/**
 * Persist one runner stream event (deduped on runnerSeq), apply its status
 * side effects (ask/env_request → blocked, acknowledgements → running),
 * renew the lease, and fan it out to SSE subscribers. Returns 'stale' when the
 * run no longer belongs to this runner so the hub can tell it to abort.
 */
export async function ingestRunnerEvent(
  runnerId: string,
  message: { runId: string; runnerSeq: number; event: AgentStreamEvent },
): Promise<IngestResult> {
  const event = storageSafeJson(message.event);
  return enqueueRunTask(message.runId, async () => {
    const run = await getAgentRun(message.runId);
    if (!run || run.runnerId !== runnerId) return { status: 'stale' };
    if (isTerminalAgentRunStatus(run.status)) return { status: 'stale' };

    // `run.accepted` and the first event are separate WebSocket frames whose
    // async handlers may race. Either is sufficient proof that this exact
    // assigned Runner opened the workspace, so finalize affinity idempotently
    // before persisting the event.
    const sessionId = await finalizeRunWorkspaceAffinity(
      message.runId,
      runnerId,
      run.sessionId,
    );

    // Persist first, publish last: subscribers must not see an `ask` before
    // the run row records it as pending (a fast answer would 409 otherwise).
    const stored = await persistEvent(message.runId, event, message.runnerSeq);

    // Apply run-row side effects even when the event itself is a duplicate
    // resend: a crash between persistEvent and this update would otherwise
    // skip the effect forever (the resend dedupes on runnerSeq). Resends
    // replay as an in-order suffix (acks are cumulative), and each effect is
    // idempotent, so replaying converges to the correct state.
    await applyRunnerEventSideEffects(message.runId, event);

    // Duplicate resend — already persisted and published once.
    if (!stored) return { status: 'ok', sessionId };
    publish(message.runId, stored);
    return { status: 'ok', sessionId };
  });
}

/** Run-row updates driven by a runner stream event (ask/environment/lease). */
async function applyRunnerEventSideEffects(
  runId: string,
  event: AgentStreamEvent,
): Promise<void> {
  if (event.type === 'ask') {
    await db
      .update(schema.agentRuns)
      .set({
        status: 'blocked',
        pendingAsk: {
          askId: event.askId,
          questions: event.questions,
        } as unknown as JsonObject,
        // Clear answers for OLDER asks, but keep one already queued for THIS
        // ask: a replayed `ask` (lost ack) or a race with answerAgentRun must
        // not drop the user's submitted answer while the runner is offline.
        pendingAnswer: sql`case
          when ${schema.agentRuns.pendingAnswer}->>'askId' = ${event.askId}
          then ${schema.agentRuns.pendingAnswer}
          else null
        end`,
        pendingEnvRequest: null,
        leaseExpiresAt: leaseDeadline(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  } else if (event.type === 'ask_answered') {
    await db
      .update(schema.agentRuns)
      .set({
        status: 'running',
        pendingAsk: null,
        pendingAnswer: null,
        leaseExpiresAt: leaseDeadline(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  } else if (event.type === 'env_request') {
    await db
      .update(schema.agentRuns)
      .set({
        status: 'blocked',
        pendingAsk: null,
        pendingAnswer: null,
        pendingEnvRequest: {
          requestId: event.requestId,
          reason: event.reason,
          variables: event.variables,
        } as unknown as JsonObject,
        leaseExpiresAt: leaseDeadline(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  } else if (event.type === 'user_message') {
    await markPendingMessageInjected(db, runId, event.pendingId);
    await db
      .update(schema.agentRuns)
      .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  } else if (event.type === 'env_stored') {
    const updated = await db
      .update(schema.agentRuns)
      .set({
        status: 'running',
        pendingEnvRequest: null,
        leaseExpiresAt: leaseDeadline(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
          sql`${schema.agentRuns.pendingEnvRequest}->>'requestId' = ${event.requestId}`,
        ),
      )
      .returning({ id: schema.agentRuns.id });
    if (updated.length === 0) {
      await db
        .update(schema.agentRuns)
        .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.agentRuns.id, runId),
            inArray(schema.agentRuns.status, ACTIVE_STATUSES),
          ),
        );
    }
  } else {
    await db
      .update(schema.agentRuns)
      .set({ leaseExpiresAt: leaseDeadline(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.agentRuns.id, runId),
          inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        ),
      );
  }
}

/**
 * Process the runner's final report for a run: persist the transcript onto
 * the session, then (if the run is still active) finish it and append the
 * terminal event. Also handles the cancel race — a run the platform already
 * cancelled still gets its partial transcript persisted here.
 */
export async function completeRunFromRunner(
  runnerId: string,
  report: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    error?: string;
    messages: unknown[];
  },
): Promise<string | null> {
  const message = storageSafeJson(report);
  return enqueueRunTask(message.runId, async () => {
    const run = await getAgentRun(message.runId);
    if (!run || run.runnerId !== runnerId) return null;

    // A very short run can send run.finished while the asynchronous
    // run.accepted handler is still committing affinity, or after cancellation
    // already made the run terminal. The final report is equally strong proof
    // that this assigned Runner opened the workspace.
    await finalizeRunWorkspaceAffinity(message.runId, runnerId, run.sessionId);

    // Persist whatever the turn produced — including a reply that was only
    // partially streamed before the user stopped the run (or before it
    // errored). Only `messages` is written back: title/provider/model were
    // set at run start, so re-applying a snapshot here would revert renames
    // or model switches made mid-run. An empty transcript is never persisted
    // (it would wipe the session history the run started from). A late or
    // retried report must also never clobber a NEWER turn's history: once a
    // more recent run exists on the session, this transcript is stale (ULIDs
    // order by creation time, so id comparison finds newer runs).
    //
    // The transcript, the run's terminal status and any automatic retry it
    // schedules commit together under the session lock (then the run lock,
    // the order every session/run transaction uses). The status is re-read
    // under that lock. If the platform already failed or interrupted this run
    // (lease expiry, dispatch timeout) and scheduled a replay, a successful
    // report settles the turn instead: the run becomes completed, resetting
    // the failure streak and dropping the schedule. A replay that started
    // first makes this transcript stale; one that starts later finds nothing
    // left to retry.
    const outcome = await db.transaction(async (tx) => {
      await tx
        .select({ id: schema.agentSessions.id })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, run.sessionId))
        .for('update');
      const [current] = await tx
        .select({
          status: schema.agentRuns.status,
          error: schema.agentRuns.error,
        })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, run.id))
        .for('update');
      if (!current) return null;

      const newerRun = await tx.query.agentRuns.findFirst({
        where: { sessionId: run.sessionId, id: { gt: run.id } },
        columns: { id: true },
      });
      const persisted = message.messages.length > 0 && !newerRun;
      if (persisted) {
        await tx
          .update(schema.agentSessions)
          .set({ messages: message.messages as JsonValue[] })
          .where(eq(schema.agentSessions.id, run.sessionId));
      }
      // Steer messages this transcript holds are delivered; anything else
      // the run claimed returns to the tray.
      await settleRunPendingMessages(
        tx,
        run.sessionId,
        run.id,
        persisted ? message.messages : null,
      );

      if (!isTerminalAgentRunStatus(current.status)) {
        const finished = await finishRunInTx(
          tx,
          message.runId,
          message.status,
          message.status === 'failed'
            ? (message.error ?? 'Agent run failed.')
            : undefined,
        );
        return { kind: 'finished' as const, ...finished };
      }

      if (
        persisted &&
        message.status === 'completed' &&
        (AGENT_AUTO_RETRY_STATUSES as readonly string[]).includes(
          current.status,
        )
      ) {
        await tx
          .update(schema.agentRuns)
          .set({
            status: 'completed',
            error: null,
            failureStreak: 0,
            autoRetryAt: null,
          })
          .where(eq(schema.agentRuns.id, run.id));
        return {
          kind: 'terminal' as const,
          status: 'completed' as const,
          error: null,
        };
      }
      return { kind: 'terminal' as const, ...current };
    });
    if (!outcome) return null;
    kickPendingDispatch(run.sessionId);

    if (outcome.kind === 'terminal') {
      // Retry of a final report whose ack was lost. A crash between finishRun
      // and appendEvent leaves the run terminal without a terminal event, so
      // SSE clients would treat the closed stream as a disconnect — repair it.
      await ensureTerminalEvent(
        message.runId,
        outcome.status,
        outcome.error,
        message.messages,
      );
      return run.sessionId;
    }

    if (!outcome.finished) return null;
    if (outcome.autoRetryAt) wakeAgentAutoRetryScheduler(outcome.autoRetryAt);
    await appendEvent(
      message.runId,
      terminalEventForStatus(message.status, message.error, message.messages),
    );
    return run.sessionId;
  });
}

/**
 * The last assistant message's terminal stop reason. A completed run whose
 * reply did not end on a clean `stop` (e.g. `length` after the model hit its
 * output limit) is still completed, but the live turn needs the reason to
 * show the same ended-early notice history renders from the transcript.
 */
const STOP_REASONS = new Set<StopReason>([
  'pending',
  'stop',
  'length',
  'toolUse',
  'error',
  'aborted',
]);

function terminalAssistantStopReason(
  messages: unknown[],
): StopReason | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      (message as { role?: unknown }).role !== 'assistant'
    ) {
      continue;
    }
    const stopReason = (message as { stopReason?: unknown }).stopReason;
    return STOP_REASONS.has(stopReason as StopReason)
      ? (stopReason as StopReason)
      : undefined;
  }
  return undefined;
}

function terminalEventForStatus(
  status: AgentRunStatus,
  error?: string | null,
  messages: unknown[] = [],
): AgentStreamEvent {
  if (status === 'completed') {
    const stopReason = terminalAssistantStopReason(messages);
    return stopReason && stopReason !== 'stop'
      ? { type: 'done', stopReason }
      : { type: 'done' };
  }
  if (status === 'cancelled') return { type: 'cancelled' };
  return { type: 'error', message: error ?? 'Agent run failed.' };
}

/** Append the terminal event for an already-terminal run if it is missing. */
async function ensureTerminalEvent(
  runId: string,
  status: AgentRunStatus,
  error?: string | null,
  messages?: unknown[],
): Promise<void> {
  const existing = await db.query.agentRunEvents.findFirst({
    where: { runId, type: { in: ['done', 'cancelled', 'error'] } },
  });
  if (existing) return;
  await appendEvent(
    runId,
    terminalEventForStatus(status, error, messages ?? []),
  );
}

/** ================== ask / answer ================== */

/**
 * Validate the user's answers against the exact questions that are still
 * pending. The HTTP route only shape-checks the payload, so without this a
 * crafted POST could resume the run with answers for unknown questions,
 * options that were never offered, multiple picks for a single-choice
 * question, or no answer at all — feeding the agent garbage decisions.
 */
function validateAskAnswers(
  questions: AskQuestion[],
  answers: AskAnswer[],
): void {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) {
      throw new Error(`Unknown question "${answer.questionId}".`);
    }
    if (seen.has(answer.questionId)) {
      throw new Error(`Duplicate answer for question "${answer.questionId}".`);
    }
    seen.add(answer.questionId);

    const validOptionIds = new Set(question.options.map((o) => o.id));
    for (const optionId of answer.selectedOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw new Error(
          `Invalid option "${optionId}" for question "${answer.questionId}".`,
        );
      }
    }
    // Custom ("Other") text counts as a choice too: the radio UI makes it
    // mutually exclusive with the options, so a single-choice answer must carry
    // exactly one of {an option, custom text} — never both. Reject duplicate
    // option ids first, otherwise ['o1','o1'] would collapse to one choice and
    // sneak past the single-choice cap (and double a label to the model).
    const uniqueSelected = new Set(answer.selectedOptionIds);
    if (uniqueSelected.size !== answer.selectedOptionIds.length) {
      throw new Error(
        `Duplicate option in answer for question "${answer.questionId}".`,
      );
    }
    const hasCustom = Boolean(answer.customText && answer.customText.trim());
    const choiceCount = uniqueSelected.size + (hasCustom ? 1 : 0);
    if (choiceCount === 0) {
      throw new Error(`Question "${answer.questionId}" needs an answer.`);
    }
    if (!question.allowMultiple && choiceCount > 1) {
      throw new Error(
        `Question "${answer.questionId}" accepts only one option.`,
      );
    }
  }
  for (const question of questions) {
    if (!seen.has(question.id)) {
      throw new Error(`Missing answer for question "${question.id}".`);
    }
  }
}

/**
 * Accept the user's answers: validate against the pending question set,
 * persist them (so a disconnected runner receives them on reconnect), and
 * forward to the runner when it is online. The run flips back to `running`
 * only when the runner confirms with its `ask_answered` event.
 */
export async function answerAgentRun(
  runId: string,
  askId: string,
  answers: AskAnswer[],
): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) {
    throw new Error('Agent run is no longer waiting.');
  }
  const pendingAsk = asPendingAsk(run.pendingAsk ?? null);
  if (!pendingAsk || pendingAsk.askId !== askId) {
    throw new Error('Question is no longer waiting.');
  }
  validateAskAnswers(pendingAsk.questions, answers);

  const updated = await db
    .update(schema.agentRuns)
    .set({
      pendingAnswer: { askId, answers } as unknown as JsonObject,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.agentRuns.id, runId),
        inArray(schema.agentRuns.status, ACTIVE_STATUSES),
        sql`${schema.agentRuns.pendingAsk}->>'askId' = ${askId}`,
        isNull(schema.agentRuns.pendingAnswer),
      ),
    )
    .returning({ id: schema.agentRuns.id });
  if (updated.length === 0) {
    throw new AppError(
      'Answer already submitted or question is no longer waiting.',
      409,
    );
  }

  sendRunAnswer(run.runnerId, runId, askId, answers);
}

/** ================== environment request / delivery ================== */

function validateEnvEntries(
  pending: PendingEnvRequestPayload,
  entries: EnvEntry[],
): EnvEntry[] {
  const parsed = envEntriesSchema.safeParse(entries);
  if (!parsed.success) {
    throw new AppError('Invalid environment values.', 400);
  }

  const expectedKeys = new Set(
    pending.variables.map((variable) => variable.key),
  );
  const submittedKeys = new Set(parsed.data.map((entry) => entry.key));
  if (
    submittedKeys.size !== parsed.data.length ||
    submittedKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !submittedKeys.has(key))
  ) {
    throw new AppError(
      'Environment keys do not match the pending request.',
      409,
    );
  }
  return parsed.data;
}

/**
 * Validate a submission against safe pending metadata, forward values only
 * through the in-memory Runner channel, and wait for a value-free result.
 * Values are never written to the run row or event log. The browser-selected
 * `secret` booleans are authoritative; model-supplied values are only UI
 * defaults and deliberately are not compared here.
 */
export async function submitAgentEnv(
  runId: string,
  requestId: string,
  entries: EnvEntry[],
): Promise<void> {
  const pendingDelivery = await enqueueRunTask(runId, async () => {
    const run = await getAgentRun(runId);
    if (!run || isTerminalAgentRunStatus(run.status)) {
      throw new AppError('Agent run is no longer waiting.', 409);
    }
    const pending = asPendingEnvRequest(run.pendingEnvRequest ?? null);
    if (!pending || pending.requestId !== requestId) {
      throw new AppError('Environment request is no longer waiting.', 409);
    }
    const validatedEntries = validateEnvEntries(pending, entries);

    return {
      result: sendRunEnvAndWait(
        run.runnerId,
        runId,
        requestId,
        validatedEntries,
      ),
    };
  });

  const result = await pendingDelivery.result;
  if (result.ok) return;
  if (result.errorCode === 'runner_unavailable') {
    throw new AppError('Agent Runner is unavailable.', 503);
  }
  if (result.errorCode === 'runner_timeout') {
    throw new AppError(
      'Agent Runner did not confirm environment storage.',
      504,
    );
  }
  throw new AppError('Agent Runner could not store the environment.', 502);
}

/** ================== cancel / interrupt / sweep ================== */

export async function cancelAgentRun(
  runId: string,
  options: FinishOptions = {},
): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) return;

  // On the per-run chain: a runner event mid-ingest must finish persisting
  // and publishing before the terminal event lands, because SSE clients
  // close the stream at the first terminal event. (The hub wait below stays
  // OFF the chain — completeRunFromRunner needs it to make progress.)
  await enqueueRunTask(runId, async () => {
    if (await finishRun(runId, 'cancelled', undefined, options)) {
      await appendEvent(runId, { type: 'cancelled' });
    }
  });

  // Tell the runner to abort, then wait (bounded) for its final report so the
  // client's post-cancel refetch sees the partial reply persisted onto the
  // session. When the runner is offline the run is already terminal; whatever
  // partial transcript arrives later is still persisted by
  // completeRunFromRunner.
  if (sendRunCancel(run.runnerId, runId)) {
    await waitForRunFinished(runId, 15000);
  }
}

export async function interruptAgentRun(
  runId: string,
  message = 'Agent run was interrupted.',
): Promise<void> {
  const run = await getAgentRun(runId);
  if (!run || isTerminalAgentRunStatus(run.status)) return;
  // Same per-run serialization as cancelAgentRun (see comment there).
  await enqueueRunTask(runId, async () => {
    if (await finishRun(runId, 'interrupted', message)) {
      await appendEvent(runId, { type: 'error', message });
    }
  });
}

/**
 * Interrupt active runs whose lease expired — the runner died or stayed
 * disconnected past the grace window. Runs with live leases are left alone
 * (their runner may just be reconnecting), which also means agent runs now
 * SURVIVE platform restarts as long as the runner keeps running.
 */
export async function sweepExpiredAgentRuns(): Promise<void> {
  // A delivery whose kick was lost (a platform restart during Send now, a
  // Runner that was away) is picked up again here; ineligible sessions exit
  // the dispatch check at once.
  await deliverPendingAfterRunnerReady();
  const rows = await db.query.agentRuns.findMany({
    where: { status: { in: ACTIVE_STATUSES } },
  });
  const now = Date.now();
  for (const run of rows) {
    const expired =
      run.leaseExpiresAt == null || run.leaseExpiresAt.getTime() <= now;
    if (!expired) continue;
    await interruptAgentRun(
      run.id,
      'Agent run was interrupted because its Agent Runner went away.',
    );
  }
}

/** Start the periodic lease sweeper (idempotent across dev reloads). */
export function ensureAgentRunSweeper(): void {
  const g = globalThis as AgentRunsGlobal;
  if (g.__hatchAgentRunSweeper__) return;
  g.__hatchAgentRunSweeper__ = setInterval(() => {
    sweepExpiredAgentRuns().catch((error) => {
      console.error('[agent-runs] lease sweep failed:', error);
    });
  }, LEASE_SWEEP_INTERVAL_MS);
}

/** ================== automatic retry ================== */

/** Stop the session's scheduled automatic retry, if any. */
export async function stopAgentAutoRetry(sessionId: string): Promise<void> {
  await abandonAutoRetry(sessionId);
}

/**
 * Drop the session's retry schedule (one run, or all of them). The failed
 * turn then stays failed, so pending messages stop being delivered.
 */
async function abandonAutoRetry(
  sessionId: string,
  runId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId))
      .for('update');
    const cleared = await tx
      .update(schema.agentRuns)
      .set({ autoRetryAt: null })
      .where(
        and(
          eq(schema.agentRuns.sessionId, sessionId),
          runId ? eq(schema.agentRuns.id, runId) : undefined,
          isNotNull(schema.agentRuns.autoRetryAt),
        ),
      )
      .returning({ id: schema.agentRuns.id });
    if (cleared.length > 0 && (await hasPendingMessages(tx, sessionId))) {
      await setPendingPaused(tx, sessionId, true);
    }
  });
}

async function fireAgentAutoRetry(run: {
  id: string;
  sessionId: string;
  providerId: string;
  modelId: string;
}): Promise<void> {
  try {
    const session = await db.query.agentSessions.findFirst({
      where: { id: run.sessionId },
      columns: { providerId: true, modelId: true },
    });
    if (!session) return;
    // Replay with the model the session last ran with.
    await startAgentRun({
      sessionId: run.sessionId,
      retry: true,
      autoRetryOfRunId: run.id,
      providerId: session.providerId ?? run.providerId,
      modelId: session.modelId ?? run.modelId,
    });
  } catch (error) {
    if (isTransientDatabaseError(error)) {
      // Keep the schedule: a deadlock victim or a dropped connection is not
      // a verdict on the turn.
      console.error('[agent-runs] automatic retry will try again:', error);
      const retryAt = new Date(Date.now() + TRANSIENT_RETRY_DELAY_MS);
      await db
        .update(schema.agentRuns)
        .set({ autoRetryAt: retryAt })
        .where(
          and(
            eq(schema.agentRuns.id, run.id),
            isNotNull(schema.agentRuns.autoRetryAt),
          ),
        );
      wakeAgentAutoRetryScheduler(retryAt);
      return;
    }
    // A conflict means a newer run, a stop, or a concurrent scheduler pass
    // already settled this schedule. Anything else (for example a removed
    // model) cannot start a run; leave the turn to a manual Retry.
    if (!(error instanceof AppError && error.status === 409)) {
      console.error('[agent-runs] automatic retry failed to start:', error);
    }
    await abandonAutoRetry(run.sessionId, run.id);
  }
}

const TRANSIENT_RETRY_DELAY_MS = 5000;

/** Deadlock, serialization failure, or a lost/closing database connection. */
function isTransientDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const pgError =
    'cause' in error && error.cause && typeof error.cause === 'object'
      ? error.cause
      : error;
  const code = (pgError as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    (code === '40P01' ||
      code === '40001' ||
      code.startsWith('08') ||
      code === '57P01' ||
      code === 'CONNECTION_CLOSED' ||
      code === 'CONNECTION_ENDED' ||
      code === 'CONNECTION_DESTROYED')
  );
}

/** Start every automatic retry that is due. */
export async function fireDueAgentAutoRetries(
  now: Date = new Date(),
): Promise<void> {
  const due = await db.query.agentRuns.findMany({
    where: { autoRetryAt: { lte: now } },
    columns: { id: true, sessionId: true, providerId: true, modelId: true },
    orderBy: { autoRetryAt: 'asc' },
  });
  await Promise.all(due.map(fireAgentAutoRetry));
}

async function nextAgentAutoRetryAt(): Promise<number | null> {
  const next = await db.query.agentRuns.findFirst({
    where: { autoRetryAt: { isNotNull: true } },
    orderBy: { autoRetryAt: 'asc' },
    columns: { autoRetryAt: true },
  });
  return next?.autoRetryAt?.getTime() ?? null;
}

function armAutoRetryScheduler(state: AutoRetryScheduler, at: number): void {
  const wakeAt = Math.min(
    at,
    state.pendingWake ?? Infinity,
    Date.now() + AGENT_AUTO_RETRY_IDLE_POLL_MS,
  );
  state.pendingWake = undefined;
  clearTimeout(state.timer);
  state.wakeAt = wakeAt;
  state.timer = setTimeout(
    () => void runAutoRetryCycle(state),
    Math.max(0, wakeAt - Date.now()),
  );
}

async function runAutoRetryCycle(state: AutoRetryScheduler): Promise<void> {
  state.running = true;
  state.wakeAt = undefined;
  let next: number | null = null;
  try {
    await fireDueAgentAutoRetries();
    next = await nextAgentAutoRetryAt();
  } catch (error) {
    console.error('[agent-runs] automatic retry check failed:', error);
  } finally {
    state.running = false;
  }
  armAutoRetryScheduler(state, next ?? Infinity);
}

/** Make the scheduler check again no later than `at`. */
function wakeAgentAutoRetryScheduler(at: Date): void {
  const state = (globalThis as AgentRunsGlobal)
    .__hatchAgentAutoRetryScheduler__;
  if (!state) return;
  const time = at.getTime();
  if (state.running) {
    state.pendingWake = Math.min(state.pendingWake ?? Infinity, time);
    return;
  }
  if (state.wakeAt !== undefined && state.wakeAt <= time) return;
  armAutoRetryScheduler(state, time);
}

/**
 * Start the automatic retry scheduler (idempotent across dev reloads). It
 * fires overdue retries right away, then sleeps until the next one is due.
 */
export function ensureAgentAutoRetryScheduler(): void {
  const g = globalThis as AgentRunsGlobal;
  if (g.__hatchAgentAutoRetryScheduler__) return;
  const state: AutoRetryScheduler = { running: false };
  g.__hatchAgentAutoRetryScheduler__ = state;
  void runAutoRetryCycle(state);
}

/** ================== pending messages (queue / steer) ================== */

type PendingDispatchGlobal = typeof globalThis & {
  /** Per-session dispatch chains: one delivery decision at a time. */
  __hatchPendingDispatchChains__?: Map<string, Promise<void>>;
};

function pendingDispatchChains(): Map<string, Promise<void>> {
  const g = globalThis as PendingDispatchGlobal;
  g.__hatchPendingDispatchChains__ ??= new Map();
  return g.__hatchPendingDispatchChains__;
}

/** Serialize work on one session's pending messages, in call order. */
export function enqueuePendingTask<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const chains = pendingDispatchChains();
  const tail = chains.get(sessionId) ?? Promise.resolve();
  const result = tail.then(task, task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(sessionId, settled);
  void settled.then(() => {
    if (chains.get(sessionId) === settled) chains.delete(sessionId);
  });
  return result;
}

/** Deliver the session's next pending messages in the background. */
export function kickPendingDispatch(sessionId: string): void {
  void enqueuePendingTask(sessionId, () =>
    dispatchPendingMessages(sessionId),
  ).catch((error: unknown) => {
    console.error('[agent-runs] pending message delivery failed:', error);
  });
}

/** Resolves once every scheduled pending delivery has finished. */
export async function pendingDispatchesSettled(): Promise<void> {
  for (;;) {
    const chains = [...pendingDispatchChains().values()];
    if (chains.length === 0) return;
    await Promise.all(chains);
  }
}

/**
 * Start the run that delivers the session's next pending messages, when the
 * session is idle: every waiting steer message together (they were meant
 * for the run that just ended), otherwise the oldest queued message alone.
 * Nothing is delivered while a run is active, delivery is paused, an
 * automatic retry is scheduled, or a Send now is starting its own run.
 */
export async function dispatchPendingMessages(
  sessionId: string,
): Promise<{ runId: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await db.query.agentSessions.findFirst({
      where: { id: sessionId },
      columns: { pendingPaused: true },
    });
    if (!session || session.pendingPaused) return null;
    if (await getActiveAgentRun(sessionId)) return null;
    const retrying = await db.query.agentRuns.findFirst({
      where: { sessionId, autoRetryAt: { isNotNull: true } },
      columns: { id: true },
    });
    if (retrying) return null;

    const now = Date.now();
    const rows = (await loadPendingRows(db, sessionId)).map((row) => ({
      row,
      status: effectivePendingStatus(row, row.claimedRunStatus, now),
    }));
    if (rows.some(({ status }) => status === 'sending')) return null;
    const waiting = rows
      .filter(({ status }) => status === 'pending')
      .map(({ row }) => row);
    const steer = waiting.filter((row) => row.mode === 'steer');
    const batch = steer.length > 0 ? steer : waiting.slice(0, 1);
    const first = batch[0];
    if (!first) return null;
    // One run uses one model and one message's limits: deliver the leading
    // messages that fit. Steer messages left over are injected into that run.
    const sameModel: typeof batch = [];
    for (const row of batch) {
      if (row.providerId !== first.providerId || row.modelId !== first.modelId)
        break;
      const candidate = [...sameModel, row];
      const content = combinePendingContent(
        candidate.map((item) => pendingRowContent(item).content),
      );
      const files = candidate.reduce(
        (count, item) =>
          count +
          pendingRowContent(item).images.length +
          pendingRowContent(item).attachments.length,
        0,
      );
      if (
        sameModel.length > 0 &&
        (!composerInputSchema.safeParse(content).success ||
          files > MAX_PENDING_RUN_FILES)
      ) {
        break;
      }
      sameModel.push(row);
    }

    const latestBefore = await db.query.agentRuns.findFirst({
      where: { sessionId },
      orderBy: { id: 'desc' },
      columns: { id: true },
    });
    try {
      const { runId } = await startAgentRun({
        sessionId,
        pendingMessageIds: sameModel.map((row) => row.id),
        providerId: first.providerId,
        modelId: first.modelId,
        userId: first.userId,
        automatic: true,
      });
      return { runId };
    } catch (error) {
      // Edited or cancelled meanwhile: decide again from fresh rows.
      if (error instanceof PendingMessagesChangedError) continue;
      // Paused or a retry is due after all: the messages keep waiting.
      if (error instanceof PendingDeliveryDeferredError) return null;
      // Another run is (or just was) active: decide again from fresh state.
      // A conflict never pauses delivery.
      if (error instanceof ActiveRunConflictError) continue;
      // No Runner yet: deliver once one connects.
      if (error instanceof AppError && error.status === 503) return null;
      // The messages cannot start a run (for example their model was
      // removed); stop delivering until the user resumes or sends one now.
      // Decide under the session lock: a run another start created
      // meanwhile delivers them later, and edited or sent messages are no
      // longer this batch.
      const batch = sameModel.map((row) => row.id);
      const paused = await db.transaction(async (tx) => {
        await tx
          .select({ id: schema.agentSessions.id })
          .from(schema.agentSessions)
          .where(eq(schema.agentSessions.id, sessionId))
          .for('update');
        const [active] = await tx
          .select({ id: schema.agentRuns.id })
          .from(schema.agentRuns)
          .where(
            and(
              eq(schema.agentRuns.sessionId, sessionId),
              inArray(schema.agentRuns.status, ACTIVE_STATUSES),
            ),
          )
          .limit(1);
        if (active) return false;
        // A run that started (and maybe already ended) since this attempt
        // read the session explains the failure: decide again.
        const latest = await tx.query.agentRuns.findFirst({
          where: { sessionId },
          orderBy: { id: 'desc' },
          columns: { id: true },
        });
        if (latest?.id !== latestBefore?.id) return false;
        const rows = await loadPendingRows(tx, sessionId);
        const stillWaiting = batch.every((id) => {
          const row = rows.find((candidate) => candidate.id === id);
          return (
            row !== undefined &&
            effectivePendingStatus(row, row.claimedRunStatus) === 'pending'
          );
        });
        if (!stillWaiting) return false;
        await setPendingPaused(tx, sessionId, true);
        return true;
      });
      if (paused) {
        console.error('[agent-runs] pending messages could not start:', error);
        return null;
      }
      continue;
    }
  }
  return null;
}

/**
 * Hand the run's waiting steer messages to its Runner. They stay editable
 * until this claim; it returns nothing unless the run is active and owned
 * by this Runner.
 */
export async function claimSteerMessages(
  runnerId: string,
  runId: string,
): Promise<SteerMessage[]> {
  const owner = await getAgentRun(runId);
  if (!owner || owner.runnerId !== runnerId) return [];
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, owner.sessionId))
      .for('update');
    const [run] = await tx
      .select({
        status: schema.agentRuns.status,
        runnerId: schema.agentRuns.runnerId,
      })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .for('update');
    if (
      !run ||
      run.runnerId !== runnerId ||
      !ACTIVE_STATUSES.includes(run.status)
    ) {
      return [];
    }
    const rows = await claimSteerRows(tx, owner.sessionId, runId);
    return rows.map(toSteerMessage);
  });
}

/** Tell the session's active run, if any, that steer messages wait. */
export async function notifyActiveRunOfSteer(sessionId: string): Promise<void> {
  const active = await db.query.agentRuns.findFirst({
    where: { sessionId, status: { in: ACTIVE_STATUSES } },
    columns: { id: true, runnerId: true },
  });
  if (active) sendRunSteer(active.runnerId, active.id);
}

/** Of these runs, the active ones whose sessions have steer messages waiting. */
export async function steerPendingRunIds(runIds: string[]): Promise<string[]> {
  if (runIds.length === 0) return [];
  const runs = await db.query.agentRuns.findMany({
    where: { id: { in: runIds }, status: { in: ACTIVE_STATUSES } },
    columns: { id: true, sessionId: true },
  });
  const result: string[] = [];
  for (const run of runs) {
    if (await hasClaimableSteer(db, run.sessionId)) result.push(run.id);
  }
  return result;
}

/** A Runner became ready: deliver messages that waited for one. */
export async function deliverPendingAfterRunnerReady(): Promise<void> {
  const sessions = await db
    .selectDistinct({ sessionId: schema.agentPendingMessages.sessionId })
    .from(schema.agentPendingMessages);
  for (const { sessionId } of sessions) kickPendingDispatch(sessionId);
}
