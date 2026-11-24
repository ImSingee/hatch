/** Loose, render-friendly shapes for persisted pi `AgentMessage`s. */

import type { StopReason } from '@earendil-works/pi-ai';
import type { AgentAttachmentRef } from '~agent/attachments';
import { stripAttachmentPrompt } from '~agent/attachments';
import {
  composerDisplayText,
  type AgentComposerContentPart,
} from '~agent/composer-content';
import type { PlainTranslationKey, useI18n } from '~i18n';

type Translate = ReturnType<typeof useI18n>['t'];

export type TextBlock = { type: 'text'; text: string };
export type ThinkingBlock = { type: 'thinking'; thinking: string };
export type ToolCallBlock = {
  type: 'toolCall';
  id: string;
  name: string;
  /** Provider output is persisted before tool validation and may be malformed. */
  arguments: unknown;
};
/**
 * A compaction marker shown inside the reply it happened in. Not part of any
 * persisted assistant message: `groupTurns` derives it from the transcript's
 * `compactionSummary` item.
 */
export type CompactionBlock = {
  type: 'compaction';
  summary: string;
  tokensBefore: number;
};
/**
 * A message the user steered into the run while it worked, shown where it was
 * injected. Not part of any persisted assistant message: `groupTurns` derives
 * it from the transcript's `steered` user message.
 */
export type SteerBlock = {
  type: 'steer';
  message: Extract<ChatMessage, { role: 'user' }>;
};
export type AssistantBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | CompactionBlock
  | SteerBlock;

export type ContentPart = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

export type ChatMessage =
  | {
      role: 'user';
      content: string | ContentPart[];
      attachments?: AgentAttachmentRef[];
      composerContent?: AgentComposerContentPart[];
      /** Injected into a running run (see `~agent/user-turns`). */
      steered?: boolean;
      /** When a steered message was injected (server clock, ISO 8601). */
      injectedAt?: string;
    }
  | {
      role: 'assistant';
      content: AssistantBlock[];
      /** Persisted pi terminal state; optional for legacy/synthetic messages. */
      stopReason?: StopReason;
      /** Provider/runtime detail when `stopReason` is `error`. */
      errorMessage?: string;
    }
  | {
      role: 'toolResult';
      /** The id of the `toolCall` block this result answers. */
      toolCallId: string;
      toolName: string;
      content: ContentPart[];
      /** Structured result data persisted by pi tools. */
      details?: unknown;
      isError?: boolean;
    }
  | {
      /**
       * Auto-compaction marker written by the Runner at the point where it
       * summarized earlier history for the model. The history itself stays in
       * the transcript.
       */
      role: 'compactionSummary';
      summary: string;
      tokensBefore: number;
      timestamp: number;
    };

export type ToolResultMessage = Extract<ChatMessage, { role: 'toolResult' }>;

/**
 * Map each tool-call id to its result message so a call and its output can be
 * rendered as a single collapsible step. A result names the call it answers,
 * so a call that never got one (its run was stopped mid-command) stays
 * without output instead of taking a later call's result. When a call has
 * several results, the newest one wins, as it does for the Runner.
 */
export function pairToolResults(
  messages: ChatMessage[],
): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === 'toolResult') map.set(message.toolCallId, message);
  }
  return map;
}

export function partsToText(
  content: string | ContentPart[],
  attachments: AgentAttachmentRef[] = [],
  composerContent?: AgentComposerContentPart[],
): string {
  if (composerContent && composerContent.length > 0) {
    return composerDisplayText(composerContent);
  }
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('');
  return stripAttachmentPrompt(text, attachments);
}

/** Image attachments in a message, as ready-to-use data URLs. */
export function partsToImages(content: string | ContentPart[]): string[] {
  if (typeof content === 'string') return [];
  return content
    .filter((p) => p.type === 'image' && typeof p.data === 'string')
    .map((p) => `data:${p.mimeType ?? 'image/png'};base64,${p.data}`);
}

/**
 * Translated labels for the platform's tools, by tool name. Historical
 * messages carry no label and live runs send the server's English one, so a
 * known tool is always named from the catalog; keep it in rough sync with the
 * server tool definitions.
 */
const TOOL_LABELS: Record<string, PlainTranslationKey> = {
  list_files: 'agent.tool.list_files',
  read_file: 'agent.tool.read_file',
  edit_file: 'agent.tool.edit_file',
  write_file: 'agent.tool.write_file',
  run_command: 'agent.tool.run_command',
  download_attachment: 'agent.tool.download_attachment',
  list_apps: 'agent.tool.list_apps',
  get_app: 'agent.tool.get_app',
  checkout_app: 'agent.tool.checkout_app',
  create_app: 'agent.tool.create_app',
  deploy_app: 'agent.tool.deploy_app',
  rollback_app: 'agent.tool.rollback_app',
  query_app_db: 'agent.tool.query_app_db',
  query_app_data_table: 'agent.tool.query_app_data_table',
  query_app_kv: 'agent.tool.query_app_kv',
  web_search: 'agent.tool.web_search',
  web_fetch: 'agent.tool.web_fetch',
  ask: 'agent.tool.ask',
  request_env: 'agent.tool.request_env',
};

/**
 * Name a known tool from the catalog; otherwise prefer the label the server
 * sent with the event, then the raw tool name.
 */
export function toolLabel(t: Translate, name: string, label?: string): string {
  const key = Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name] : undefined;
  return key ? t(key) : (label ?? name);
}

/**
 * Prefer a tool-call-specific UI title when one exists. Tool arguments are
 * persisted while live-only labels are not, so derive the Run Command title
 * from its purpose in both render paths and retain the static label as a
 * legacy/malformed-input fallback.
 */
export function toolDisplayLabel(
  t: Translate,
  name: string,
  value: unknown,
  label?: string,
): string {
  if (name === 'run_command') {
    const purpose = toolArgumentsRecord(value)?.purpose;
    if (typeof purpose === 'string') {
      const oneLine = purpose.replace(/\s+/g, ' ').trim();
      if (oneLine) return oneLine;
    }
  }
  return toolLabel(t, name, label);
}

export type ToolDetail = {
  value: string;
  ellipsis: 'start' | 'end';
};

export function toolArgumentsRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function listFilesPathArgument(value: unknown): string | undefined {
  const args = toolArgumentsRecord(value);
  if (!args) return undefined;
  if (!Object.hasOwn(args, 'path')) return '.';
  if (typeof args.path !== 'string') return undefined;
  return args.path === '' ? '.' : args.path;
}

/** A short argument hint shown next to a tool step, e.g. the path or id. */
export function toolDetail(
  name: string,
  value: unknown,
): ToolDetail | undefined {
  if (name === 'list_files') {
    const path = listFilesPathArgument(value);
    return path === undefined ? undefined : { value: path, ellipsis: 'start' };
  }
  const args = toolArgumentsRecord(value);
  if (!args) return undefined;
  const pick = (
    key: string,
    ellipsis: ToolDetail['ellipsis'] = 'end',
  ): ToolDetail | undefined => {
    const value = args[key];
    return typeof value === 'string' ? { value, ellipsis } : undefined;
  };
  const raw =
    name === 'run_command'
      ? pick('command')
      : name === 'web_search'
        ? pick('query')
        : name === 'web_fetch'
          ? pick('url')
          : (pick('id') ?? pick('path', 'start') ?? pick('name'));
  if (!raw) return undefined;
  const oneLine = raw.value.replace(/\s+/g, ' ').trim();
  if (!oneLine) return undefined;
  return {
    value:
      raw.ellipsis === 'end' && oneLine.length > 48
        ? `${oneLine.slice(0, 48)}…`
        : oneLine,
    ellipsis: raw.ellipsis,
  };
}

function isLosslessJson(value: unknown, ancestors: Set<object>): boolean {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  const keys = Object.keys(value);
  // JSON.stringify serializes array holes as null, ignores non-index array
  // properties and symbol keys, and defers to toJSON on other prototypes.
  // Arrays therefore need exactly one own enumerable key per index.
  const plainShape = Array.isArray(value)
    ? prototype === Array.prototype &&
      keys.length === value.length &&
      keys.every((key, index) => key === String(index))
    : prototype === Object.prototype || prototype === null;
  if (!plainShape || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  ancestors.add(value);
  const lossless = keys.every((key) =>
    isLosslessJson((value as Record<string, unknown>)[key], ancestors),
  );
  // Shared, non-cyclic references are valid JSON and serialize as copies.
  ancestors.delete(value);
  return lossless;
}

/**
 * Model-supplied arguments as indented JSON, with KV write values masked unless
 * the request explicitly makes the entry public. An omitted secret flag keeps
 * an existing entry's flag, so its value must also be treated as sensitive.
 * Returns undefined rather than displaying a lossy serialization.
 */
export function toolRequestJson(
  name: string,
  value: unknown,
): string | undefined {
  try {
    if (!isLosslessJson(value, new Set())) return undefined;
    const args = toolArgumentsRecord(value);
    const redactValue =
      name === 'query_app_kv' &&
      args?.action === 'set' &&
      args.secret !== false &&
      Object.hasOwn(args, 'value');
    return JSON.stringify(
      redactValue ? { ...args, value: '[REDACTED]' } : value,
      null,
      2,
    );
  } catch {
    // Throwing getters or proxies cannot be shown faithfully either.
    return undefined;
  }
}

/** A tool input field: its label and what an empty value shows. */
type ToolInputField = {
  label: PlainTranslationKey;
  emptyText: PlainTranslationKey;
};

const INPUT = {
  filePath: {
    label: 'agent.tool.input.filePath',
    emptyText: 'agent.tool.input.filePathEmpty',
  },
  fileContents: {
    label: 'agent.tool.input.fileContents',
    emptyText: 'agent.tool.input.fileContentsEmpty',
  },
  questions: {
    label: 'agent.tool.input.questions',
    emptyText: 'agent.tool.input.questionsEmpty',
  },
  command: {
    label: 'agent.tool.input.command',
    emptyText: 'agent.tool.input.commandEmpty',
  },
  query: {
    label: 'agent.tool.input.query',
    emptyText: 'agent.tool.input.queryEmpty',
  },
  maxResults: {
    label: 'agent.tool.input.maxResults',
    emptyText: 'agent.tool.input.maxResultsEmpty',
  },
  searchDepth: {
    label: 'agent.tool.input.searchDepth',
    emptyText: 'agent.tool.input.searchDepthEmpty',
  },
  topic: {
    label: 'agent.tool.input.topic',
    emptyText: 'agent.tool.input.topicEmpty',
  },
  timeRange: {
    label: 'agent.tool.input.timeRange',
    emptyText: 'agent.tool.input.timeRangeEmpty',
  },
  includeDomains: {
    label: 'agent.tool.input.includeDomains',
    emptyText: 'agent.tool.input.includeDomainsEmpty',
  },
  excludeDomains: {
    label: 'agent.tool.input.excludeDomains',
    emptyText: 'agent.tool.input.excludeDomainsEmpty',
  },
  url: {
    label: 'agent.tool.input.url',
    emptyText: 'agent.tool.input.urlEmpty',
  },
  extractDepth: {
    label: 'agent.tool.input.extractDepth',
    emptyText: 'agent.tool.input.extractDepthEmpty',
  },
} satisfies Record<string, ToolInputField>;

/** The file path field, which the step view fills from resolved results. */
export const FILE_PATH_INPUT: ToolInputField = INPUT.filePath;

/** An input value under its field's catalog label (translated at render). */
export type ToolInputDetail = ToolInputField & { value: string };

function appendSerializableInput(
  details: ToolInputDetail[],
  field: ToolInputField,
  value: unknown,
): void {
  if (typeof value === 'string') {
    details.push({ ...field, value });
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    details.push({ ...field, value: String(value) });
    return;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    details.push({ ...field, value: JSON.stringify(value) });
  }
}

/** Complete inputs that need an inspectable form beyond the compact summary. */
export function toolInputDetails(
  t: Translate,
  name: string,
  value: unknown,
): ToolInputDetail[] | undefined {
  if (name === 'list_files') {
    const path = listFilesPathArgument(value);
    if (path === undefined) return undefined;
    return [{ ...INPUT.filePath, value: path }];
  }
  const args = toolArgumentsRecord(value);
  if (!args) return undefined;
  if (name === 'ask' && Array.isArray(args.questions)) {
    const questions = args.questions.flatMap((value, index) => {
      const question = toolArgumentsRecord(value);
      if (typeof question?.prompt !== 'string') return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((value) => {
            const option = toolArgumentsRecord(value);
            return typeof option?.label === 'string'
              ? [`- ${option.label}`]
              : [];
          })
        : [];
      return [
        [
          `${index + 1}. ${question.prompt}`,
          ...(question.allowMultiple === true
            ? [t('agent.tool.input.selectMultiple')]
            : []),
          ...options,
        ].join('\n'),
      ];
    });
    return questions.length > 0
      ? [{ ...INPUT.questions, value: questions.join('\n\n') }]
      : undefined;
  }
  if (name === 'run_command' && typeof args.command === 'string') {
    return [{ ...INPUT.command, value: args.command }];
  }
  if (
    (name === 'read_file' || name === 'edit_file') &&
    typeof args.path === 'string'
  ) {
    return [{ ...INPUT.filePath, value: args.path }];
  }
  if (name === 'web_search') {
    const details: ToolInputDetail[] = [];
    appendSerializableInput(details, INPUT.query, args.query);
    appendSerializableInput(details, INPUT.maxResults, args.max_results);
    appendSerializableInput(details, INPUT.searchDepth, args.search_depth);
    appendSerializableInput(details, INPUT.topic, args.topic);
    appendSerializableInput(details, INPUT.timeRange, args.time_range);
    appendSerializableInput(
      details,
      INPUT.includeDomains,
      args.include_domains,
    );
    appendSerializableInput(
      details,
      INPUT.excludeDomains,
      args.exclude_domains,
    );
    return details.length > 0 ? details : undefined;
  }
  if (name === 'web_fetch') {
    const details: ToolInputDetail[] = [];
    appendSerializableInput(details, INPUT.url, args.url);
    appendSerializableInput(details, INPUT.query, args.query);
    appendSerializableInput(details, INPUT.extractDepth, args.extract_depth);
    return details.length > 0 ? details : undefined;
  }
  if (name === 'write_file') {
    const details: ToolInputDetail[] = [];
    if (typeof args.path === 'string') {
      details.push({ ...INPUT.filePath, value: args.path });
    }
    if (typeof args.content === 'string') {
      details.push({ ...INPUT.fileContents, value: args.content });
    }
    return details.length > 0 ? details : undefined;
  }
  return undefined;
}

/**
 * App ids that an assistant turn successfully deployed, in call order.
 *
 * A tool call alone only means the Agent attempted a deploy. Requiring its
 * paired, non-error result keeps failed or incomplete calls from producing a
 * misleading app action in the finished transcript.
 */
export function successfullyDeployedAppIds(
  blocks: AssistantBlock[],
  toolResults: ReadonlyMap<string, ToolResultMessage> | undefined,
): string[] {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'toolCall' && block.name === 'deploy_app') {
      const result = toolResults?.get(block.id);
      if (!result || result.isError) continue;
      const id = toolArgumentsRecord(block.arguments)?.id;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return [...ids];
}
