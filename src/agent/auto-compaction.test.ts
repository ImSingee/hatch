import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import {
  compactionSettings,
  compactionTriggerTokens,
  createTranscriptCompactor,
} from './auto-compaction';
import { Transcript } from './transcript';

const user = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: 1 }) as AgentMessage;

function newTranscript(items: unknown[]) {
  return Transcript.load(items);
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

describe('Transcript.load', () => {
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
    const transcript = newTranscript([
      messages[0],
      broken[0],
      messages[1],
      broken[1],
      messages[2],
    ]);

    // Neither marker describes a context, so the model sees every message.
    expect(transcript.modelContext()).toEqual(messages);
    expect(transcript.serialize()).toEqual(messages);
  });
});

describe('createTranscriptCompactor', () => {
  it('gives up instead of looping when the model leaves no input budget', async () => {
    const { models, model } = setup({ contextWindow: 8000, maxTokens: 7999 });
    const transcript = newTranscript([user('hello')]);
    const compactor = createTranscriptCompactor({ transcript, models, model });
    expect(await compactor.compactAfterOverflow()).toBe(false);
  });

  it('carries the previous summary into a compaction that splits the kept turn', async () => {
    const { faux, models, model } = setup({
      contextWindow: 200000,
      maxTokens: 20000,
    });
    const summaryPrompts: string[] = [];
    faux.setResponses(
      Array.from({ length: 4 }, () => (context) => {
        const prompt = JSON.stringify(context.messages);
        summaryPrompts.push(prompt);
        // Like a model updating a summary: earlier facts survive only when
        // the request actually carried them.
        return fauxAssistantMessage(
          prompt.includes('FIRST-SUMMARY-FACTS')
            ? 'FIRST-SUMMARY-FACTS and the current request'
            : 'the current request only',
        );
      }),
    );
    const toolRound = (id: string) => [
      fauxAssistantMessage({
        type: 'toolCall',
        id,
        name: 'read',
        arguments: {},
      }),
      {
        role: 'toolResult',
        toolCallId: id,
        toolName: 'read',
        content: [{ type: 'text', text: 'y'.repeat(120000) }],
        isError: false,
        timestamp: 1,
      },
    ];
    // The earlier compaction kept exactly from this turn's user message, so
    // the next one finds no older history in front of the turn it splits.
    const transcript = newTranscript([
      user('old request'),
      fauxAssistantMessage('old answer'),
      user('current request'),
      {
        role: 'compactionSummary',
        summary: 'FIRST-SUMMARY-FACTS',
        tokensBefore: 150000,
        timestamp: 1,
        firstKeptIndex: 2,
      },
      ...toolRound('call-1'),
      ...toolRound('call-2'),
    ]);

    const compactor = createTranscriptCompactor({ transcript, models, model });
    expect(await compactor.compactAfterOverflow()).toBe(true);

    expect(summaryPrompts).toHaveLength(1);
    expect(summaryPrompts[0]).toContain('FIRST-SUMMARY-FACTS');
    expect(summaryPrompts[0]).toContain('current request');
    // The context the next request sends still holds the earlier facts.
    const context = transcript.modelContext();
    expect(context.map((message) => message.role)).toEqual([
      'compactionSummary',
      'assistant',
      'toolResult',
    ]);
    expect(JSON.stringify(context[0])).toContain('FIRST-SUMMARY-FACTS');
  });

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
    const transcript = newTranscript([
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

    const compactor = createTranscriptCompactor({ transcript, models, model });
    expect(await compactor.compactIfOverThreshold()).toBe(true);

    const context = transcript.modelContext();
    expect(context[0]?.role).toBe('compactionSummary');
    // The tool call and its result stay together in the kept tail.
    expect(context.map((message) => message.role).slice(-2)).toEqual([
      'assistant',
      'toolResult',
    ]);
    expect(context.length).toBeLessThan(history.length);
    const stored = transcript.serialize();
    expect(stored).toHaveLength(history.length + 4);
  });
});
