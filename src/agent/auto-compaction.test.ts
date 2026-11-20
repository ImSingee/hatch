import {
  InMemorySessionRepo,
  type AgentMessage,
} from '@earendil-works/pi-agent-core';
import { createModels, type Api, type Model } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it, vi } from 'vitest';
import {
  compactionTriggerTokens,
  compactSessionMessages,
  createMidTurnCompactor,
  isOverCompactThreshold,
  pinMaxOutputTokens,
  transcriptBeforeLastUserMessage,
} from './auto-compaction';

const userMessage = (text: string): AgentMessage =>
  ({
    role: 'user',
    content: text,
    timestamp: 1,
  }) as AgentMessage;

/** Alternating user/assistant history, `chars` of text per message. */
function conversation(messages: number, chars: number): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let index = 0; index < messages; index++) {
    history.push(
      index % 2 === 0
        ? userMessage('x'.repeat(chars))
        : fauxAssistantMessage('x'.repeat(chars)),
    );
  }
  return history;
}

function assistantWithUsage(inputTokens: number): AgentMessage {
  const message = fauxAssistantMessage('ok');
  return {
    ...message,
    usage: {
      input: inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe('compactionTriggerTokens', () => {
  it('reserves the pinned output budget from the input threshold', () => {
    expect(
      compactionTriggerTokens({ contextWindow: 128000, maxTokens: 8192 }),
    ).toBe((128000 - 8192) * 0.8);
  });

  it('falls back to the full window when maxTokens is misconfigured', () => {
    expect(
      compactionTriggerTokens({ contextWindow: 1000, maxTokens: 2000 }),
    ).toBe(1000 * 0.8);
  });
});

describe('isOverCompactThreshold', () => {
  const model = { contextWindow: 40000, maxTokens: 4000 };
  const trigger = (40000 - 4000) * 0.8; // 28800

  it('stays under at the boundary and crosses just above it', () => {
    const trailing = userMessage('tail');
    expect(
      isOverCompactThreshold(
        [assistantWithUsage(trigger - 200), trailing],
        model,
      ),
    ).toBe(false);
    expect(
      isOverCompactThreshold(
        [assistantWithUsage(Math.ceil(trigger)), trailing],
        model,
      ),
    ).toBe(true);
  });

  it('uses the character heuristic when no usage is available', () => {
    // 4 chars ≈ 1 token under the pi heuristic.
    expect(isOverCompactThreshold(conversation(1, 100), model)).toBe(false);
    expect(
      isOverCompactThreshold(
        conversation(1, Math.ceil(trigger) * 4 + 4),
        model,
      ),
    ).toBe(true);
  });
});

describe('transcriptBeforeLastUserMessage', () => {
  it('drops everything from the last user message on', () => {
    const history = conversation(5, 10);
    const head = transcriptBeforeLastUserMessage(history);
    expect(head).toEqual(history.slice(0, 4));
  });

  it('returns undefined without any user message', () => {
    expect(
      transcriptBeforeLastUserMessage([fauxAssistantMessage('hi')]),
    ).toBeUndefined();
  });
});

describe('pinMaxOutputTokens', () => {
  it.each([
    { payload: { max_tokens: 12 }, key: 'max_tokens' },
    { payload: { max_completion_tokens: 12 }, key: 'max_completion_tokens' },
    { payload: { max_output_tokens: 12 }, key: 'max_output_tokens' },
  ])('pins $key to the configured value', ({ payload, key }) => {
    const pinned = pinMaxOutputTokens(
      { ...payload, model: 'm' },
      4096,
    ) as Record<string, unknown>;
    expect(pinned[key]).toBe(4096);
    expect(pinned.model).toBe('m');
  });

  it('leaves payloads without an output-cap field untouched', () => {
    const payload = { model: 'm', temperature: 0.5 };
    expect(pinMaxOutputTokens(payload, 4096)).toBe(payload);
  });
});

describe('createMidTurnCompactor', () => {
  function setup() {
    const faux = fauxProvider({
      provider: 'mid-turn-test',
      models: [{ id: 'tiny', contextWindow: 30000, maxTokens: 2000 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    return {
      faux,
      model: faux.getModel() as Model<Api>,
      models,
    };
  }

  it('returns undefined while under the trigger', async () => {
    const { model, models } = setup();
    const compactor = createMidTurnCompactor({ models, model });
    expect(await compactor(conversation(2, 100))).toBeUndefined();
  });

  it('replaces the head with a summary and reuses it while the tail fits', async () => {
    const { faux, model, models } = setup();
    faux.setResponses([fauxAssistantMessage('condensed history')]);
    const onEvent = vi.fn<(phase: string, tokensBefore?: number) => void>();
    const compactor = createMidTurnCompactor({ models, model, onEvent });
    // 6 messages × 5000 est. tokens = 30000 > trigger 22400; the retained
    // tail is ~20000 so the head (first two messages) gets summarized.
    const messages = conversation(6, 20000);

    const compacted = await compactor(messages);
    expect(compacted).toHaveLength(5);
    expect(compacted?.[0]?.role).toBe('compactionSummary');
    expect(onEvent.mock.calls.map((call) => call[0])).toEqual([
      'start',
      'done',
    ]);
    expect(faux.state.callCount).toBe(1);

    // The head is unchanged and the tail still fits, so the generated summary
    // is reused without another summarization call.
    const grown = [...messages, userMessage('a bit more')];
    const again = await compactor(grown);
    expect(again?.[0]).toBe(compacted?.[0]);
    expect(again).toHaveLength(6);
    expect(faux.state.callCount).toBe(1);
  });
});

describe('compactSessionMessages', () => {
  function setup() {
    const faux = fauxProvider({
      provider: 'session-compact-test',
      models: [{ id: 'tiny', contextWindow: 30000, maxTokens: 2000 }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    return {
      faux,
      model: faux.getModel() as Model<Api>,
      models,
    };
  }

  it('reports nothing when the whole history fits in the retained tail', async () => {
    const { model, models } = setup();
    const repo = new InMemorySessionRepo();
    const session = await repo.create({ id: 's-small' });
    for (const message of conversation(2, 100)) {
      await session.appendMessage(message);
    }
    const onStart = vi.fn<() => void>();
    expect(
      await compactSessionMessages({ session, models, model, onStart }),
    ).toEqual({ status: 'nothing' });
    // `start` must never open a compaction step that cannot close.
    expect(onStart).not.toHaveBeenCalled();
  });

  it('persists a compaction entry whose context view leads with a summary', async () => {
    const { faux, model, models } = setup();
    faux.setResponses([fauxAssistantMessage('condensed history')]);
    const repo = new InMemorySessionRepo();
    const session = await repo.create({ id: 's-big' });
    for (const message of conversation(6, 20000)) {
      await session.appendMessage(message);
    }

    const onStart = vi.fn<() => void>();
    const outcome = await compactSessionMessages({
      session,
      models,
      model,
      onStart,
    });
    expect(outcome.status).toBe('compacted');
    expect(onStart).toHaveBeenCalledTimes(1);
    if (outcome.status !== 'compacted') return;
    expect(outcome.tokensBefore).toBeGreaterThan(outcome.tokensAfter);
    expect((await session.buildContext()).messages[0]?.role).toBe(
      'compactionSummary',
    );
  });
});
