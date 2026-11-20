import type { JsonValue } from '../core';

function record(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * The blocks a stored message shows. A user message that mentions an App or
 * Workflow keeps its text in `composerContent`, while its photos stay in
 * `content`; both are shown.
 */
export function messageBlocks(message: Record<string, JsonValue>) {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: message.content ?? null }];
  // An empty composer array carries no text; the stored content does.
  if (
    message.role !== 'user' ||
    !Array.isArray(message.composerContent) ||
    !message.composerContent.length
  )
    return content;
  return [
    ...message.composerContent,
    ...content.filter((part) => record(part)?.type === 'image'),
  ];
}

/**
 * The index of the assistant message that ends each turn — the last one
 * before the next user message (or the transcript's end). Only its
 * `stopReason` describes how that reply ended: an intermediate `toolUse`
 * is a normal step in a turn whose tools went on to run.
 */
export function terminalReplyIndexes(messages: JsonValue[]): Set<number> {
  const terminal = new Set<number>();
  let pending = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = record(messages[index])?.role;
    if (role === 'assistant' && pending === -1) pending = index;
    if (role === 'user' && pending !== -1) {
      terminal.add(pending);
      pending = -1;
    }
  }
  if (pending !== -1) terminal.add(pending);
  return terminal;
}
