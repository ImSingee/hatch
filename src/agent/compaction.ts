/**
 * Context compaction primitives: token estimates, cut-point selection, and
 * summary generation over a transcript branch.
 *
 * Ported from `@earendil-works/pi-agent-core` 0.83.0
 * (`src/harness/compaction/compaction.ts` and `utils.ts`, MIT,
 * https://github.com/earendil-works/pi), which pi-agent-core 1.0 removed.
 * The prompts and the cut-point rules are kept verbatim so compactions
 * continue to produce the same summaries and keep the same tails.
 */
import type {
  AgentMessage,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
  contentText,
  retryAssistantCall,
  uuidv7,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai';
import type { JsonValue } from '~/db/schema';
import { convertToLlm } from './llm-messages';
import {
  lastCompactionIndex,
  type CompactionEntry,
  type MessageEntry,
  type TranscriptEntry,
} from './transcript';

export type CompactionSettings = {
  /** Tokens reserved for the summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
};

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** File lists stored on compaction markers and carried into later summaries. */
type CompactionDetails = { readFiles: string[]; modifiedFiles: string[] };

type FileOperations = {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
};

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

// ---------------------------------------------------------------------------
// Token estimates

function calculateContextTokens(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

function assistantUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== 'assistant') return undefined;
  const assistant = message as AssistantMessage;
  return assistant.stopReason !== 'aborted' &&
    assistant.stopReason !== 'error' &&
    assistant.usage &&
    calculateContextTokens(assistant.usage) > 0
    ? assistant.usage
    : undefined;
}

/** Usage of the last valid assistant reply among `entries`. */
export function getLastAssistantUsage(
  entries: readonly TranscriptEntry[],
): Usage | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const usage =
      entry.type === 'message' ? assistantUsage(entry.message) : undefined;
    if (usage) return usage;
  }
  return undefined;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function contentChars(
  content: string | readonly { type: string; text?: string }[],
): number {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text' && block.text) chars += block.text.length;
    else if (block.type === 'image') chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** Conservative character-based token estimate of one message. */
export function estimateTokens(message: AgentMessage): number {
  switch (message.role) {
    case 'user':
    case 'toolResult':
      return Math.ceil(contentChars(message.content) / 4);
    case 'assistant': {
      let chars = 0;
      for (const block of message.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall') {
          chars +=
            block.name.length + safeJsonStringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case 'compactionSummary':
      return Math.ceil(message.summary.length / 4);
    default:
      return 0;
  }
}

/**
 * Estimated context tokens: the newest assistant usage plus the messages
 * after it, or the per-message heuristic when no usage exists.
 */
export function estimateContextTokens(
  messages: readonly AgentMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = assistantUsage(messages[index]);
    if (!usage) continue;
    let trailing = 0;
    for (const message of messages.slice(index + 1)) {
      trailing += estimateTokens(message);
    }
    return calculateContextTokens(usage) + trailing;
  }
  return messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
}

// ---------------------------------------------------------------------------
// Cut points

function messageRole(entry: TranscriptEntry): string | undefined {
  return entry.type === 'message' ? entry.message.role : undefined;
}

/** Context may start at any message except a tool result. */
function validCutPoints(
  entries: readonly TranscriptEntry[],
  start: number,
  end: number,
): number[] {
  const cutPoints: number[] = [];
  for (let index = start; index < end; index++) {
    const role = messageRole(entries[index]);
    if (role !== undefined && role !== 'toolResult') cutPoints.push(index);
  }
  return cutPoints;
}

function findTurnStartIndex(
  entries: readonly TranscriptEntry[],
  entryIndex: number,
  start: number,
): number {
  for (let index = entryIndex; index >= start; index--) {
    if (messageRole(entries[index]) === 'user') return index;
  }
  return -1;
}

type CutPoint = {
  firstKeptIndex: number;
  /** Start of the turn the cut splits, or -1. */
  turnStartIndex: number;
  isSplitTurn: boolean;
};

/** The cut that keeps roughly `keepRecentTokens` of recent messages. */
function findCutPoint(
  entries: readonly TranscriptEntry[],
  start: number,
  end: number,
  keepRecentTokens: number,
): CutPoint {
  const cutPoints = validCutPoints(entries, start, end);
  if (cutPoints.length === 0) {
    return { firstKeptIndex: start, turnStartIndex: -1, isSplitTurn: false };
  }
  let accumulated = 0;
  let cutIndex = cutPoints[0];
  for (let index = end - 1; index >= start; index--) {
    const entry = entries[index];
    if (entry.type !== 'message') continue;
    accumulated += estimateTokens(entry.message);
    if (accumulated >= keepRecentTokens) {
      cutIndex = cutPoints.find((cut) => cut >= index) ?? cutIndex;
      break;
    }
  }
  const isUserMessage = messageRole(entries[cutIndex]) === 'user';
  const turnStartIndex = isUserMessage
    ? -1
    : findTurnStartIndex(entries, cutIndex, start);
  return {
    firstKeptIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

// ---------------------------------------------------------------------------
// File operations carried in summaries

function extractFileOps(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== 'assistant') return;
  for (const block of message.content) {
    if (block.type !== 'toolCall') continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    const path = typeof args?.path === 'string' ? args.path : undefined;
    if (!path) continue;
    if (block.name === 'read') fileOps.read.add(path);
    else if (block.name === 'write') fileOps.written.add(path);
    else if (block.name === 'edit') fileOps.edited.add(path);
  }
}

function fileLists(fileOps: FileOperations): CompactionDetails {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function formatFileOperations({
  readFiles,
  modifiedFiles,
}: CompactionDetails): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`,
    );
  }
  return sections.length === 0 ? '' : `\n\n${sections.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Preparation

export type CompactionPreparation = {
  firstKept: MessageEntry;
  messagesToSummarize: AgentMessage[];
  /** Prefix of a split turn, summarized separately. */
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
};

/**
 * Split a transcript branch into the history to summarize and the tail to
 * keep, or undefined when there is nothing to compact.
 */
export function prepareCompaction(
  branch: readonly TranscriptEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  if (branch.length === 0 || branch.at(-1)?.type === 'compaction') {
    return undefined;
  }
  const previousIndex = lastCompactionIndex(branch);
  const previous =
    previousIndex >= 0 ? (branch[previousIndex] as CompactionEntry) : undefined;
  let boundaryStart = 0;
  if (previous) {
    const keptIndex = branch.indexOf(previous.firstKept);
    boundaryStart = keptIndex >= 0 ? keptIndex : previousIndex + 1;
  }
  const cut = findCutPoint(
    branch,
    boundaryStart,
    branch.length,
    settings.keepRecentTokens,
  );
  const firstKept = branch[cut.firstKeptIndex];
  if (firstKept?.type !== 'message') return undefined;

  // Compaction markers inside the range are already summarized history.
  const messagesIn = (start: number, end: number) =>
    branch
      .slice(start, end)
      .filter((entry): entry is MessageEntry => entry.type === 'message')
      .map((entry) => entry.message);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptIndex;
  const messagesToSummarize = messagesIn(boundaryStart, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? messagesIn(cut.turnStartIndex, cut.firstKeptIndex)
    : [];

  const fileOps: FileOperations = {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };
  const previousDetails = previous?.details as
    | Partial<CompactionDetails>
    | undefined;
  if (Array.isArray(previousDetails?.readFiles)) {
    for (const file of previousDetails.readFiles) fileOps.read.add(file);
  }
  if (Array.isArray(previousDetails?.modifiedFiles)) {
    for (const file of previousDetails.modifiedFiles) fileOps.edited.add(file);
  }
  for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
    extractFileOps(message, fileOps);
  }

  return {
    firstKept,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cut.isSplitTurn,
    previousSummary: previous?.summary,
    fileOps,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Summaries

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Plain-text rendering of LLM messages for summarization prompts. */
function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const content = contentText(message.content, '');
      if (content) parts.push(`[User]: ${content}`);
    } else if (message.role === 'assistant') {
      const thinking: string[] = [];
      const toolCalls: string[] = [];
      for (const block of message.content) {
        if (block.type === 'thinking') {
          thinking.push(block.thinking);
        } else if (block.type === 'toolCall') {
          const args = Object.entries(
            block.arguments as Record<string, unknown>,
          )
            .map(([key, value]) => `${key}=${safeJsonStringify(value)}`)
            .join(', ');
          toolCalls.push(`${block.name}(${args})`);
        }
      }
      if (thinking.length > 0) {
        parts.push(`[Assistant thinking]: ${thinking.join('\n')}`);
      }
      if (message.content.some((block) => block.type === 'text')) {
        parts.push(`[Assistant]: ${contentText(message.content)}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
      }
    } else if (message.role === 'toolResult') {
      const content = contentText(message.content, '');
      if (content) {
        parts.push(
          `[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`,
        );
      }
    }
  }
  return parts.join('\n\n');
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

type SummaryRequest = {
  models: Models;
  model: Model<Api>;
  signal?: AbortSignal;
  thinkingLevel?: ThinkingLevel;
};

class SummaryError extends Error {}

async function requestSummary(
  request: SummaryRequest,
  promptText: string,
  maxTokens: number,
  label: string,
): Promise<string> {
  const { models, model, signal, thinkingLevel } = request;
  const options: SimpleStreamOptions = {
    maxTokens,
    signal,
    ...(model.reasoning && thinkingLevel && thinkingLevel !== 'off'
      ? { reasoning: thinkingLevel }
      : {}),
    // Summaries are standalone requests: isolate routing and skip cache
    // writes that could never be reused.
    cacheRetention: 'none',
    sessionId: uuidv7(),
  };
  const context: Context = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        timestamp: Date.now(),
      },
    ],
  };
  const response = await retryAssistantCall(
    () => models.completeSimple(model, context, options),
    undefined,
    signal,
  );
  if (response.stopReason === 'aborted') {
    throw new SummaryError(response.errorMessage || `${label} aborted`);
  }
  if (response.stopReason === 'error') {
    throw new SummaryError(
      `${label} failed: ${response.errorMessage || 'Unknown error'}`,
    );
  }
  return contentText(response.content);
}

function summaryMaxTokens(
  model: Model<Api>,
  reserveTokens: number,
  share: number,
): number {
  return Math.min(
    Math.floor(share * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
}

function generateSummary(
  request: SummaryRequest,
  messages: AgentMessage[],
  reserveTokens: number,
  previousSummary: string | undefined,
): Promise<string> {
  let promptText = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += previousSummary
    ? UPDATE_SUMMARIZATION_PROMPT
    : SUMMARIZATION_PROMPT;
  return requestSummary(
    request,
    promptText,
    summaryMaxTokens(request.model, reserveTokens, 0.8),
    'Summarization',
  );
}

function generateTurnPrefixSummary(
  request: SummaryRequest,
  messages: AgentMessage[],
  reserveTokens: number,
): Promise<string> {
  const promptText = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  return requestSummary(
    request,
    promptText,
    summaryMaxTokens(request.model, reserveTokens, 0.5),
    'Turn prefix summarization',
  );
}

export type CompactionResult = {
  summary: string;
  firstKept: MessageEntry;
  details: JsonValue;
};

/**
 * Summarize the prepared history. Resolves undefined when a summary request
 * fails or is aborted.
 */
export async function compact(
  preparation: CompactionPreparation,
  request: SummaryRequest,
): Promise<CompactionResult | undefined> {
  const {
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    previousSummary,
    settings,
  } = preparation;
  let summary: string;
  try {
    if (isSplitTurn && turnPrefixMessages.length > 0) {
      const history =
        messagesToSummarize.length > 0
          ? await generateSummary(
              request,
              messagesToSummarize,
              settings.reserveTokens,
              previousSummary,
            )
          : 'No prior history.';
      const prefix = await generateTurnPrefixSummary(
        request,
        turnPrefixMessages,
        settings.reserveTokens,
      );
      summary = `${history}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix}`;
    } else {
      summary = await generateSummary(
        request,
        messagesToSummarize,
        settings.reserveTokens,
        previousSummary,
      );
    }
  } catch (error) {
    if (error instanceof SummaryError) return undefined;
    throw error;
  }
  const details = fileLists(preparation.fileOps);
  return {
    summary: summary + formatFileOperations(details),
    firstKept: preparation.firstKept,
    details,
  };
}
