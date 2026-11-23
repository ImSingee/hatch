import type { StopReason } from '@earendil-works/pi-ai';
import type { AgentRunStatus } from '~/db/schema';
import type { SessionRunTiming } from '~server/agent-runs';
import { isUserTurnMessage } from '~agent/user-turns';
import type { AssistantBlock, ChatMessage } from './types';
import type { WorkPhase, WorkTiming } from './work-process';

export type RenderTurn =
  | { kind: 'user'; key: string; userTurn: number; message: ChatMessage }
  | {
      kind: 'assistant';
      key: string;
      /**
       * The user turn this reply answers (see `~agent/user-turns`), which
       * binds it to its run; null for a reply before any user message.
       */
      userTurn: number | null;
      blocks: AssistantBlock[];
      stopReason?: StopReason;
      errorMessage?: string;
    };

/**
 * Collapse one agent reply — which the backend may split across several
 * assistant + tool-result messages — into a single turn. Tool-result messages
 * are dropped because they are merged into their call rows by `pairToolResults`.
 * Blocks keep their order, so the reply's last text stays its final answer.
 * A compaction marker joins the reply it happened in as one more step.
 */
export function groupTurns(messages: ChatMessage[]): RenderTurn[] {
  const turns: RenderTurn[] = [];
  let userTurns = 0;
  messages.forEach((message, index) => {
    if (message.role === 'user' && message.steered) {
      // A steered message belongs to the reply of the run it was injected
      // into: it never starts a user turn (see `~agent/user-turns`).
      const block: AssistantBlock = { type: 'steer', message };
      const last = turns.at(-1);
      if (last?.kind === 'assistant') {
        last.blocks = [...last.blocks, block];
      } else {
        turns.push({
          kind: 'assistant',
          key: `m${index}`,
          userTurn: userTurns > 0 ? userTurns - 1 : null,
          blocks: [block],
        });
      }
    } else if (message.role === 'user') {
      turns.push({
        kind: 'user',
        key: `m${index}`,
        userTurn: userTurns,
        message,
      });
      userTurns += 1;
    } else if (
      message.role === 'assistant' ||
      message.role === 'compactionSummary'
    ) {
      const blocks: AssistantBlock[] =
        message.role === 'assistant'
          ? message.content
          : [
              {
                type: 'compaction',
                summary: message.summary,
                tokensBefore: message.tokensBefore,
              },
            ];
      const stopReason =
        message.role === 'assistant' ? message.stopReason : undefined;
      const errorMessage =
        message.role === 'assistant' ? message.errorMessage : undefined;
      const last = turns.at(-1);
      if (last?.kind === 'assistant') {
        last.blocks = [...last.blocks, ...blocks];
        last.stopReason = stopReason ?? last.stopReason;
        last.errorMessage = errorMessage ?? last.errorMessage;
      } else {
        turns.push({
          kind: 'assistant',
          key: `m${index}`,
          userTurn: userTurns > 0 ? userTurns - 1 : null,
          blocks: [...blocks],
          ...(stopReason ? { stopReason } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        });
      }
    }
  });
  return turns;
}

/**
 * Index of a reply's final answer: its last non-empty text block. Everything
 * before it is the work process; -1 means the reply has no answer text.
 */
export function finalTextIndex<Block>(
  blocks: readonly Block[],
  textOf: (block: Block) => string | undefined,
): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (textOf(blocks[index])?.trim()) return index;
  }
  return -1;
}

export function isActiveRunStatus(status: AgentRunStatus): boolean {
  return status === 'running' || status === 'blocked';
}

/**
 * Terminal stop reasons that mean the reply did not end normally even though
 * nothing failed: `length` when the model hit its output limit, `toolUse` or
 * `pending` when the transcript ends before the model finished. (`error` and
 * `aborted` already surface through the run's own status.)
 */
export function isIncompleteStopReason(
  stopReason: StopReason | undefined,
): boolean {
  return (
    stopReason === 'length' ||
    stopReason === 'toolUse' ||
    stopReason === 'pending'
  );
}

/**
 * How a persisted reply ended. The transcript's own stop reason wins; the run
 * status covers ends the transcript cannot express (interrupted, stopped
 * before any output). Unbound legacy replies read as finished.
 */
export function persistedWorkPhase(
  run: SessionRunTiming | undefined,
  stopReason: StopReason | undefined,
): WorkPhase {
  if (run && isActiveRunStatus(run.status)) return 'running';
  if (stopReason === 'error') return 'failed';
  if (stopReason === 'aborted') return 'cancelled';
  if (run?.status === 'cancelled') return 'cancelled';
  if (run?.status === 'failed' || run?.status === 'interrupted') {
    return 'failed';
  }
  if (isIncompleteStopReason(stopReason)) return 'incomplete';
  return 'completed';
}

/**
 * The assistant message to render for a run's reply. A failed or interrupted
 * run whose transcript does not record the failure (or holds no reply at all)
 * shows the run's own error, so the notice survives without a toast.
 */
export function replyMessage(
  blocks: AssistantBlock[],
  stopReason: StopReason | undefined,
  errorMessage: string | undefined,
  run: SessionRunTiming | undefined,
): Extract<ChatMessage, { role: 'assistant' }> {
  const runFailed = run?.status === 'failed' || run?.status === 'interrupted';
  if (runFailed && stopReason !== 'error') {
    return {
      role: 'assistant',
      content: blocks,
      stopReason: 'error',
      ...(run.error ? { errorMessage: run.error } : {}),
    };
  }
  return {
    role: 'assistant',
    content: blocks,
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

/** Index in `messages` of the user message for `userTurn`, or -1. */
export function userMessageIndexOfTurn(
  messages: readonly ChatMessage[],
  userTurn: number,
): number {
  let turn = -1;
  for (let index = 0; index < messages.length; index++) {
    if (!isUserTurnMessage(messages[index])) continue;
    turn += 1;
    if (turn === userTurn) return index;
  }
  return -1;
}

/** A stretch of one reply between the steered messages injected into it. */
export type ReplySegment = {
  /** Block range of the segment's own work, `[start, end)`. */
  start: number;
  end: number;
  /** Index of the steered message that ends it; absent on the last one. */
  steer?: number;
};

/**
 * Split a reply at its steered messages. The chat shows each injected message
 * as a message of its own and frames the work before and after it apart.
 */
export function replySegments<Block>(
  blocks: readonly Block[],
  isSteer: (block: Block) => boolean,
): ReplySegment[] {
  const segments: ReplySegment[] = [];
  let start = 0;
  blocks.forEach((block, index) => {
    if (!isSteer(block)) return;
    segments.push({ start, end: index, steer: index });
    start = index + 1;
  });
  segments.push({ start, end: blocks.length });
  return segments;
}

/**
 * The time each segment of a reply worked: the run's start to the first
 * injection, between injections, then to the run's end. A segment next to an
 * undated injection has no reliable time.
 */
export function segmentTimings(
  timing: WorkTiming,
  injectedAt: readonly (string | undefined)[],
): WorkTiming[] {
  const marks = injectedAt.map((value) => {
    const time = value === undefined ? Number.NaN : Date.parse(value);
    return Number.isNaN(time) ? null : time;
  });
  return Array.from({ length: marks.length + 1 }, (_, index) => {
    if (!timing) return null;
    const startedAt = index === 0 ? timing.startedAt : marks[index - 1];
    if (startedAt === null) return null;
    if (index === marks.length) {
      return {
        startedAt,
        ...(timing.endedAt === undefined ? {} : { endedAt: timing.endedAt }),
      };
    }
    const endedAt = marks[index];
    return endedAt === null ? null : { startedAt, endedAt };
  });
}
