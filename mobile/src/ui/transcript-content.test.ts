import { describe, expect, it } from 'vitest';
import { messageBlocks, terminalReplyIndexes } from './transcript-content';

const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

describe('stored message blocks', () => {
  it('shows mentions from composer content together with stored photos', () => {
    const blocks = messageBlocks({
      role: 'user',
      content: [{ type: 'text', text: 'Fix @Notes' }, image],
      composerContent: [
        { type: 'text', text: 'Fix ' },
        { type: 'app', id: 'a1', name: 'Notes' },
      ],
    });
    expect(blocks).toEqual([
      { type: 'text', text: 'Fix ' },
      { type: 'app', id: 'a1', name: 'Notes' },
      image,
    ]);
  });

  it('shows plain content as stored when there is no composer content', () => {
    const content = [{ type: 'text', text: 'Hello' }, image];
    expect(messageBlocks({ role: 'user', content })).toEqual(content);
    expect(messageBlocks({ role: 'assistant', content: 'Hi' })).toEqual([
      { type: 'text', text: 'Hi' },
    ]);
  });

  it('falls back to the stored content when composer content is empty', () => {
    const content = [{ type: 'text', text: 'Plain words' }, image];
    expect(
      messageBlocks({ role: 'user', content, composerContent: [] }),
    ).toEqual(content);
  });
});

describe('terminal reply indexes', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'q' }] };
  const assistant = (stopReason: string) => ({
    role: 'assistant',
    content: [{ type: 'text', text: 'a' }],
    stopReason,
  });
  const toolResult = {
    role: 'toolResult',
    content: [{ type: 'text', text: 'ok' }],
  };

  it('marks only the last assistant message of a tool-using turn', () => {
    // The intermediate `toolUse` step is normal work, not an early end.
    expect(
      terminalReplyIndexes([
        user,
        assistant('toolUse'),
        toolResult,
        assistant('stop'),
      ]),
    ).toEqual(new Set([3]));
  });

  it('marks the last assistant message of each turn', () => {
    expect(
      terminalReplyIndexes([
        user,
        assistant('length'),
        user,
        assistant('stop'),
      ]),
    ).toEqual(new Set([1, 3]));
  });

  it('marks an assistant reply left terminal mid-tool-work', () => {
    // The run ended before the last tool call could be answered.
    expect(
      terminalReplyIndexes([user, assistant('toolUse'), toolResult]),
    ).toEqual(new Set([1]));
  });
});

describe('steered messages', () => {
  it('do not end the reply they joined', () => {
    const user = { role: 'user', content: 'Build it' };
    const assistant = (stopReason: string) => ({
      role: 'assistant',
      content: [],
      stopReason,
    });
    expect(
      terminalReplyIndexes([
        user,
        assistant('toolUse'),
        { role: 'user', content: 'Use blue', steered: true },
        assistant('stop'),
      ]),
    ).toEqual(new Set([3]));
  });
});
