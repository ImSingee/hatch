/**
 * The Agent session transcript as stored by the platform: every message in
 * order, plus a `compactionSummary` marker wherever a compaction happened.
 * A marker holds the summary and `firstKeptIndex`, the index of the first
 * message that stayed in the model's context. Nothing is ever removed, so the
 * chat history and earlier runs' user-turn bindings stay intact; only the
 * model-bound context is derived from the markers.
 *
 * Context derivation reproduces the session model of
 * `@earendil-works/pi-agent-core` 0.83.0 (`getPathToRootOrCompaction`,
 * `defaultContextEntryTransform`, MIT, https://github.com/earendil-works/pi)
 * on a linear list, so stored transcripts keep producing the same context.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { JsonValue } from '~/db/schema';
import type { CompactionSummaryMessage } from './llm-messages';

const COMPACTION_MARKER_ROLE = 'compactionSummary';

export type MessageEntry = { type: 'message'; message: AgentMessage };

export type CompactionEntry = {
  type: 'compaction';
  summary: string;
  tokensBefore: number;
  timestamp: number;
  /** First message kept in the model's context after this compaction. */
  firstKept: MessageEntry;
  details?: JsonValue;
};

export type TranscriptEntry = MessageEntry | CompactionEntry;

type ParsedMarker = {
  summary: string;
  tokensBefore: number;
  timestamp: number;
  firstKeptIndex: number;
  details?: JsonValue;
};

function hasMarkerRole(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { role?: unknown }).role === COMPACTION_MARKER_ROLE
  );
}

function parseMarker(value: unknown): ParsedMarker | null {
  const { summary, tokensBefore, timestamp, firstKeptIndex, details } =
    value as Record<string, unknown>;
  if (
    typeof summary !== 'string' ||
    typeof tokensBefore !== 'number' ||
    typeof timestamp !== 'number' ||
    typeof firstKeptIndex !== 'number' ||
    !Number.isSafeInteger(firstKeptIndex) ||
    firstKeptIndex < 0
  ) {
    return null;
  }
  return {
    summary,
    tokensBefore,
    timestamp,
    firstKeptIndex,
    ...(details === undefined ? {} : { details: details as JsonValue }),
  };
}

function summaryMessage(entry: CompactionEntry): CompactionSummaryMessage {
  return {
    role: COMPACTION_MARKER_ROLE,
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
    timestamp: entry.timestamp,
  };
}

/** Index of the last compaction entry, or -1. */
export function lastCompactionIndex(
  entries: readonly TranscriptEntry[],
): number {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].type === 'compaction') return index;
  }
  return -1;
}

/** The model-context messages of one transcript entry. */
export function entryMessage(entry: TranscriptEntry): AgentMessage {
  return entry.type === 'message' ? entry.message : summaryMessage(entry);
}

export class Transcript {
  readonly #entries: TranscriptEntry[] = [];

  /**
   * Load a stored transcript. A marker that does not point at an earlier
   * message cannot describe any context and is dropped, so it also
   * disappears from the next `serialize()`.
   */
  static load(items: readonly unknown[]): Transcript {
    const transcript = new Transcript();
    const messageEntries: (MessageEntry | undefined)[] = [];
    for (const [index, item] of items.entries()) {
      if (!hasMarkerRole(item)) {
        messageEntries[index] = transcript.appendMessage(item as AgentMessage);
        continue;
      }
      const marker = parseMarker(item);
      const firstKept =
        marker && marker.firstKeptIndex < index
          ? messageEntries[marker.firstKeptIndex]
          : undefined;
      if (!marker || !firstKept) continue;
      transcript.#entries.push({
        type: 'compaction',
        summary: marker.summary,
        tokensBefore: marker.tokensBefore,
        timestamp: marker.timestamp,
        firstKept,
        ...(marker.details === undefined ? {} : { details: marker.details }),
      });
    }
    return transcript;
  }

  get entries(): readonly TranscriptEntry[] {
    return this.#entries;
  }

  appendMessage(message: AgentMessage): MessageEntry {
    const entry: MessageEntry = { type: 'message', message };
    this.#entries.push(entry);
    return entry;
  }

  appendCompaction(compaction: {
    summary: string;
    firstKept: MessageEntry;
    tokensBefore: number;
    details?: JsonValue;
  }): CompactionEntry {
    const entry: CompactionEntry = {
      type: 'compaction',
      timestamp: Date.now(),
      ...compaction,
    };
    this.#entries.push(entry);
    return entry;
  }

  /**
   * The entries the current context and the next compaction work on: walking
   * back from the end, each compaction moves the stop to its first kept
   * message, and the walk ends at the stop that is reached.
   */
  branch(): TranscriptEntry[] {
    let stop: TranscriptEntry | undefined;
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      const entry = this.#entries[index];
      if (stop !== undefined && entry === stop) {
        return this.#entries.slice(index);
      }
      if (entry.type === 'compaction') stop = entry.firstKept;
    }
    return [...this.#entries];
  }

  /**
   * The model-bound context: the newest compaction's summary, the messages it
   * kept, and everything after it.
   */
  modelContext(): AgentMessage[] {
    const branch = this.branch();
    const lastIndex = lastCompactionIndex(branch);
    if (lastIndex < 0) return branch.map(entryMessage);
    const last = branch[lastIndex] as CompactionEntry;
    const keptStart = branch.indexOf(last.firstKept);
    const kept =
      keptStart >= 0 && keptStart < lastIndex
        ? branch.slice(keptStart, lastIndex)
        : [];
    return [last, ...kept, ...branch.slice(lastIndex + 1)].map(entryMessage);
  }

  /** The complete transcript: every message plus the compaction markers. */
  serialize(): JsonValue[] {
    const items: JsonValue[] = [];
    const indexByEntry = new Map<MessageEntry, number>();
    for (const entry of this.#entries) {
      if (entry.type === 'message') {
        indexByEntry.set(entry, items.length);
        items.push(entry.message as unknown as JsonValue);
        continue;
      }
      const firstKeptIndex = indexByEntry.get(entry.firstKept);
      if (firstKeptIndex === undefined) continue;
      items.push({
        role: COMPACTION_MARKER_ROLE,
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: entry.timestamp,
        firstKeptIndex,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      });
    }
    return items;
  }
}
