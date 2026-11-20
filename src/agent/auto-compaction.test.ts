import {
  InMemorySessionRepo,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import {
  compactionSettings,
  compactionTriggerTokens,
  createSessionCompactor,
  openTranscriptSession,
} from './auto-compaction';

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: 1 }) as AgentMessage;

async function newSession(transcript: unknown[]) {
  const session = await new InMemorySessionRepo().create({ id: 'test' });
  return {
    session,
    transcript: await openTranscriptSession(session, transcript),
  };
}

function setup(model: { contextWindow: number; maxTokens: number }) {
  const faux = fauxProvider({
    provider: 'auto-compaction-test',
    models: [{ id: 'test-model', ...model }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() as Model<Api> };
}

describe('compaction budget', () => {
  it('reserves the output budget and keeps the tail inside a small window', () => {
    const small = { contextWindow: 8000, maxTokens: 2000 };
    const trigger = compactionTriggerTokens(small);
    expect(trigger).toBe((8000 - 2000) * 0.8);
    // The pi defaults (20000 kept, 16384 reserved) exceed this whole window;
    // a compaction must still be able to bring the context under the trigger.
    const settings = compactionSettings(small);
    expect(settings.keepRecentTokens + settings.reserveTokens).toBeLessThan(
      trigger,
    );
  });
});

describe('openTranscriptSession', () => {
  it('drops a marker that does not point at an earlier message', async () => {
    const messages = [user('one'), fauxAssistantMessage('two'), user('three')];
    const broken = [
      {
        role: 'compactionSummary',
        summary: 's',
        tokensBefore: 1,
        timestamp: 1,
      },
      {
        role: 'compactionSummary',
        summary: 's',
        tokensBefore: 1,
        timestamp: 1,
        firstKeptIndex: 9,
      },
    ];
    const { session, transcript } = await newSession([
      messages[0],
      broken[0],
      messages[1],
      broken[1],
      messages[2],
    ]);

    // Neither marker describes a context, so the model sees every message.
    expect((await session.buildContext()).messages).toEqual(messages);
    expect(await transcript.serialize()).toEqual(messages);
  });
});

describe('createSessionCompactor', () => {
  it('summarizes the history in front of a tool result larger than the tail budget', async () => {
    const { faux, models, model } = setup({
      contextWindow: 200000,
      maxTokens: 20000,
    });
    faux.setResponses(
      Array.from({ length: 4 }, () => fauxAssistantMessage('condensed')),
    );
    const call = fauxAssistantMessage({
      type: 'toolCall',
      id: 'call-1',
      name: 'read',
      arguments: {},
    });
    const history: unknown[] = [];
    for (let index = 0; index < 8; index++) {
      history.push(user('x'.repeat(40000)), fauxAssistantMessage('ok'));
    }
    const { session, transcript } = await newSession([
      ...history,
      user('read the file'),
      call,
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        // ~150000 tokens: far beyond the 20000-token tail pi tries to keep,
        // and pi cannot cut in front of a tool result.
        content: [{ type: 'text', text: 'y'.repeat(600000) }],
        isError: false,
        timestamp: 1,
      },
    ]);

    const compactor = createSessionCompactor({ session, models, model });
    expect(await compactor.compactIfOverThreshold()).toBe(true);

    const context = (await session.buildContext()).messages;
    expect(context[0]?.role).toBe('compactionSummary');
    // The tool call and its result stay together in the kept tail.
    expect(context.map((message) => message.role).slice(-2)).toEqual([
      'assistant',
      'toolResult',
    ]);
    expect(context.length).toBeLessThan(history.length);
    const stored = await transcript.serialize();
    expect(stored).toHaveLength(history.length + 4);
  });
});
