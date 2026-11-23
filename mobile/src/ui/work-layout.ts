import type { JsonValue, RunStatus, SessionDetail, StreamState } from '../core';

/**
 * How the transcript folds each Agent reply's process (reasoning, tool calls,
 * prose said along the way) under one work line, the same way the web chat
 * does (`src/components/agent/work-process.tsx`). The list keeps one row per
 * stored message; this says what each row shows.
 */
export type WorkPhase =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'incomplete';

type Run = SessionDetail['runs'][number];

/** One reply, or the part of it before or after a steered message. */
export type WorkSegment = {
  /** Stable across refetches: the run (or first row) plus the part. */
  key: string;
  phase: WorkPhase;
  /** Server-clock milliseconds; null when the reply has no bound run. */
  startedAt: number | null;
  endedAt: number | null;
  /** Tool calls and context compactions inside the process. */
  steps: number;
  /** Whether anything precedes the answer; the line is static otherwise. */
  hasProcess: boolean;
};

export type TranscriptRow =
  | { kind: 'speaker' }
  | {
      kind: 'reply';
      segment: WorkSegment;
      /** The first row of its segment, which carries the work line. */
      leads: boolean;
      /**
       * Content blocks from this index on are the answer, which stays shown
       * when the process folds; `Infinity` means the whole row is process.
       */
      answerFrom: number;
    };

function record(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function contentOf(message: Record<string, JsonValue>): JsonValue[] {
  return Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: message.content ?? null }];
}

function nonEmpty(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Whether a stored block shows something in the process. */
function visible(block: JsonValue): boolean {
  const part = record(block);
  if (!part) return false;
  if (part.type === 'text') return nonEmpty(part.text);
  if (part.type === 'thinking') return nonEmpty(part.thinking);
  return part.type === 'toolCall';
}

function isActive(status: RunStatus): boolean {
  return status === 'running' || status === 'blocked';
}

/** How a stored reply ended; mirrors the web's `persistedWorkPhase`. */
function persistedPhase(
  run: Run | undefined,
  stopReason: JsonValue | undefined,
): WorkPhase {
  if (run && isActive(run.status)) return 'running';
  if (stopReason === 'error') return 'failed';
  if (stopReason === 'aborted') return 'cancelled';
  if (run?.status === 'cancelled') return 'cancelled';
  if (run?.status === 'failed' || run?.status === 'interrupted') {
    return 'failed';
  }
  if (
    stopReason === 'length' ||
    stopReason === 'toolUse' ||
    stopReason === 'pending'
  ) {
    return 'incomplete';
  }
  return 'completed';
}

function time(value: JsonValue | string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

type Part = { rows: number[]; steer?: number };

/**
 * One row per message. User messages are speakers; every other row belongs
 * to a reply segment. A steered message splits its reply: the work before it
 * is finished and folds on its own, like the web chat.
 */
export function transcriptRows(
  messages: readonly JsonValue[],
  runs: readonly Run[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = messages.map(() => ({ kind: 'speaker' }));
  const runByTurn = new Map<number, Run>();
  for (const run of runs) runByTurn.set(run.userTurn, run);

  // Group the rows of each reply into parts split by steered messages.
  type Reply = { userTurn: number | null; parts: Part[] };
  const replies: Reply[] = [];
  let userTurns = 0;
  let reply: Reply | null = null;
  messages.forEach((value, index) => {
    const message = record(value);
    const role = message?.role;
    if (role === 'user' && message?.steered !== true) {
      userTurns += 1;
      reply = null;
      return;
    }
    if (!reply) {
      reply = {
        userTurn: userTurns > 0 ? userTurns - 1 : null,
        parts: [{ rows: [] }],
      };
      replies.push(reply);
    }
    const part = reply.parts.at(-1)!;
    if (role === 'user') {
      part.steer = index;
      reply.parts.push({ rows: [] });
    } else {
      part.rows.push(index);
    }
  });

  for (const { userTurn, parts } of replies) {
    const run = userTurn === null ? undefined : runByTurn.get(userTurn);
    const runStart = time(run?.startedAt);
    const runEnd = time(run?.completedAt);
    parts.forEach((part, partIndex) => {
      if (!part.rows.length) return;
      const last = partIndex === parts.length - 1;
      const messagesOf = part.rows.map((index) => record(messages[index])!);
      const terminal = messagesOf.findLast(
        (message) => message.role === 'assistant',
      );
      const phase = last
        ? persistedPhase(run, terminal?.stopReason)
        : 'completed';
      // The answer is the part's last non-empty text, once it has settled.
      let answerRow = -1;
      let answerBlock = -1;
      if (phase !== 'running') {
        part.rows.forEach((index, at) => {
          const message = messagesOf[at];
          if (message.role !== 'assistant') return;
          contentOf(message).forEach((block, blockIndex) => {
            const part = record(block);
            if (part?.type === 'text' && nonEmpty(part.text)) {
              answerRow = index;
              answerBlock = blockIndex;
            }
          });
        });
      }
      let steps = 0;
      let hasProcess = false;
      const answerFrom = new Map<number, number>();
      part.rows.forEach((index, at) => {
        const message = messagesOf[at];
        const from =
          answerRow === -1 || index < answerRow
            ? Number.POSITIVE_INFINITY
            : index === answerRow
              ? answerBlock
              : 0;
        answerFrom.set(index, from);
        if (message.role === 'compactionSummary') {
          if (from > 0) {
            steps += 1;
            hasProcess = true;
          }
          return;
        }
        if (message.role !== 'assistant') return;
        contentOf(message)
          .slice(0, from)
          .forEach((block) => {
            if (record(block)?.type === 'toolCall') steps += 1;
            if (visible(block)) hasProcess = true;
          });
      });
      // Before a steer the part ends when that message was injected.
      const steerAt =
        part.steer === undefined
          ? null
          : time(record(messages[part.steer])?.injectedAt);
      const previousSteer = partIndex > 0 ? parts[partIndex - 1].steer : null;
      const startedAt =
        partIndex === 0
          ? runStart
          : previousSteer === undefined || previousSteer === null
            ? null
            : time(record(messages[previousSteer])?.injectedAt);
      const endedAt = last ? runEnd : steerAt;
      const segment: WorkSegment = {
        key: `${run?.id ?? `row-${part.rows[0]}`}:${partIndex}`,
        phase,
        startedAt: run ? startedAt : null,
        endedAt: run && startedAt !== null ? endedAt : null,
        steps,
        hasProcess,
      };
      part.rows.forEach((index, at) => {
        rows[index] = {
          kind: 'reply',
          segment,
          leads: at === 0,
          answerFrom: answerFrom.get(index)!,
        };
      });
    });
  }
  return rows;
}

/**
 * How the live reply stands: running until its stream ends, then how it
 * ended. A held reply (stopped or interrupted before it was saved) reads its
 * run when the stream itself did not say.
 */
export function livePhase(
  state: Pick<StreamState, 'terminal' | 'stopReason'>,
  settled: boolean,
  runStatus?: RunStatus,
): WorkPhase {
  if (state.terminal === 'error') return 'failed';
  if (state.terminal === 'cancelled') return 'cancelled';
  if (state.terminal === 'done') {
    return state.stopReason === 'length' ||
      state.stopReason === 'toolUse' ||
      state.stopReason === 'pending'
      ? 'incomplete'
      : 'completed';
  }
  if (!settled) return 'running';
  return runStatus === 'failed' || runStatus === 'interrupted'
    ? 'failed'
    : 'cancelled';
}

/** A finished reply folds its process; any other end stays open. */
export function defaultWorkExpanded(phase: WorkPhase): boolean {
  return phase !== 'completed';
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const PHASE_WORDS: Record<WorkPhase, { lead: string; span: string }> = {
  running: { lead: 'Working', span: 'for' },
  completed: { lead: 'Worked', span: 'for' },
  failed: { lead: 'Failed', span: 'after' },
  cancelled: { lead: 'Stopped', span: 'after' },
  incomplete: { lead: 'Ended early', span: 'after' },
};

/**
 * The line's words: "Working for 42s · Build the App" while running,
 * "Worked for 1m 12s · 6 steps" once ended. Same copy as the web chat.
 */
export function workWords({
  phase,
  elapsed,
  steps,
  current,
}: {
  phase: WorkPhase;
  /** Milliseconds, or null without a known time. */
  elapsed: number | null;
  steps: number;
  current?: string;
}): { lead: string; rest: string } {
  const words = PHASE_WORDS[phase];
  const detail =
    phase === 'running'
      ? current
      : steps > 0
        ? steps === 1
          ? '1 step'
          : `${steps} steps`
        : undefined;
  return {
    lead: words.lead,
    rest: [
      elapsed === null ? '' : ` ${words.span} ${formatElapsed(elapsed)}`,
      detail ? ` · ${detail}` : '',
    ].join(''),
  };
}

/**
 * Stored tool results by the call they answer, for results whose call is in
 * the transcript: those show on their call's step instead of a row of their
 * own.
 */
export function toolResultsByCall(
  messages: readonly JsonValue[],
): Map<string, Record<string, JsonValue>> {
  const calls = new Set<string>();
  for (const value of messages) {
    const message = record(value);
    if (message?.role !== 'assistant') continue;
    for (const block of contentOf(message)) {
      const part = record(block);
      if (part?.type === 'toolCall' && typeof part.id === 'string') {
        calls.add(part.id);
      }
    }
  }
  const results = new Map<string, Record<string, JsonValue>>();
  for (const value of messages) {
    const message = record(value);
    if (
      message?.role === 'toolResult' &&
      typeof message.toolCallId === 'string' &&
      calls.has(message.toolCallId)
    ) {
      results.set(message.toolCallId, message);
    }
  }
  return results;
}
