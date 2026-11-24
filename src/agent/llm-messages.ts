/**
 * Agent transcript messages beyond the LLM roles, and their conversion to the
 * LLM context.
 *
 * The compaction summary message and its context wording are ported from
 * `@earendil-works/pi-agent-core` 0.83.0 (`src/harness/messages.ts`, MIT,
 * https://github.com/earendil-works/pi), which pi-agent-core 1.0 removed.
 * The wording must stay stable: it is what the model reads in front of every
 * compacted context.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** Model-context stand-in for the history a compaction summarized. */
export type CompactionSummaryMessage = {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
};

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    compactionSummary: CompactionSummaryMessage;
  }
}

/** Convert Agent messages to LLM messages; other custom roles are dropped. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((message): Message[] => {
    switch (message.role) {
      case 'compactionSummary':
        return [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  COMPACTION_SUMMARY_PREFIX +
                  message.summary +
                  COMPACTION_SUMMARY_SUFFIX,
              },
            ],
            timestamp: message.timestamp,
          },
        ];
      case 'system':
      case 'user':
      case 'assistant':
      case 'toolResult':
        return [message];
      default:
        return [];
    }
  });
}
