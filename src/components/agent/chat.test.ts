import { describe, expect, it } from 'vitest';
import { nextUserTurn } from '~agent/user-turns';
import type { SessionRunTiming } from '~server/agent-runs';
import { groupTurns, persistedWorkPhase } from './chat-turns';
import {
  type AssistantBlock,
  type ChatMessage,
  type ToolResultMessage,
  successfullyDeployedAppIds,
} from './types';

describe('successfullyDeployedAppIds', () => {
  it('keeps successful deploys in call order and drops failed or incomplete calls', () => {
    const blocks: AssistantBlock[] = [
      {
        type: 'toolCall',
        id: 'deploy-a',
        name: 'deploy_app',
        arguments: { id: 'alpha' },
      },
      {
        type: 'toolCall',
        id: 'deploy-b',
        name: 'deploy_app',
        arguments: { id: 'beta' },
      },
      {
        type: 'toolCall',
        id: 'deploy-c',
        name: 'deploy_app',
        arguments: { id: 'gamma' },
      },
      {
        type: 'toolCall',
        id: 'deploy-a-again',
        name: 'deploy_app',
        arguments: { id: 'alpha' },
      },
    ];
    const result = (isError = false): ToolResultMessage => ({
      role: 'toolResult',
      toolName: 'deploy_app',
      content: [{ type: 'text', text: 'result' }],
      isError,
    });
    const toolResults = new Map([
      ['deploy-a', result()],
      ['deploy-b', result(true)],
      ['deploy-a-again', result()],
    ]);

    expect(successfullyDeployedAppIds(blocks, toolResults)).toEqual(['alpha']);
  });
});

describe('groupTurns', () => {
  it('keeps a terminal assistant error when it follows partial output', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Build it' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I started the work.' }],
      },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'OpenAI API error (402): no body',
      },
    ];

    expect(groupTurns(messages)).toEqual([
      { kind: 'user', key: 'm0', userTurn: 0, message: messages[0] },
      {
        kind: 'assistant',
        key: 'm1',
        userTurn: 0,
        blocks: [{ type: 'text', text: 'I started the work.' }],
        stopReason: 'error',
        errorMessage: 'OpenAI API error (402): no body',
      },
    ]);
  });

  it('keeps an empty error reply as a visible assistant turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
      },
    ];

    expect(groupTurns(messages)[1]).toMatchObject({
      kind: 'assistant',
      blocks: [],
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    });
  });

  it('binds each reply to the user turn its run recorded', () => {
    // Matches the platform's count: the n-th `role: 'user'` message is user
    // turn n, including a prompt whose run never produced a reply.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First' },
      { role: 'user', content: 'Dispatch failed for this one' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call-1', name: 'list_apps', arguments: {} },
        ],
      },
      { role: 'toolResult', toolName: 'list_apps', content: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: 'Third' },
    ];

    expect(
      groupTurns(messages).map((turn) => [turn.kind, turn.userTurn]),
    ).toEqual([
      ['user', 0],
      ['user', 1],
      ['assistant', 1],
      ['user', 2],
    ]);
    expect(nextUserTurn(messages)).toBe(3);
  });

  it('shows a compaction marker as a step of the reply it happened in', () => {
    // The transcript keeps the whole history; the marker only records where
    // the model's context was summarized.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'First' },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] },
      { role: 'user', content: 'Second' },
      {
        role: 'compactionSummary',
        summary: 'Earlier work condensed.',
        tokensBefore: 120000,
        timestamp: 1,
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ];

    const turns = groupTurns(messages);
    expect(turns.map((turn) => [turn.kind, turn.userTurn])).toEqual([
      ['user', 0],
      ['assistant', 0],
      ['user', 1],
      ['assistant', 1],
    ]);
    expect(turns[3]).toMatchObject({
      blocks: [
        {
          type: 'compaction',
          summary: 'Earlier work condensed.',
          tokensBefore: 120000,
        },
        { type: 'text', text: 'Done.' },
      ],
    });
    // The marker is not a user message, so turn numbering stays aligned with
    // the platform's nextUserTurn count.
    expect(nextUserTurn(messages)).toBe(2);
  });
});

describe('persistedWorkPhase', () => {
  const completedRun: SessionRunTiming = {
    id: 'run_1',
    status: 'completed',
    userTurn: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:30.000Z',
    error: null,
  };

  it('marks a completed reply that ended early as incomplete', () => {
    expect(persistedWorkPhase(completedRun, 'length')).toBe('incomplete');
    expect(persistedWorkPhase(completedRun, 'toolUse')).toBe('incomplete');
    expect(persistedWorkPhase(completedRun, 'pending')).toBe('incomplete');
  });

  it('keeps clean, failed and cancelled ends ahead of the transcript', () => {
    expect(persistedWorkPhase(completedRun, 'stop')).toBe('completed');
    expect(persistedWorkPhase(completedRun, 'error')).toBe('failed');
    expect(persistedWorkPhase(completedRun, 'aborted')).toBe('cancelled');
    expect(
      persistedWorkPhase({ ...completedRun, status: 'cancelled' }, 'length'),
    ).toBe('cancelled');
    expect(
      persistedWorkPhase({ ...completedRun, status: 'failed' }, 'length'),
    ).toBe('failed');
  });

  it('shows an interrupted run as failed even when its reply was aborted', () => {
    expect(
      persistedWorkPhase({ ...completedRun, status: 'interrupted' }, 'aborted'),
    ).toBe('failed');
    expect(
      persistedWorkPhase({ ...completedRun, status: 'cancelled' }, 'aborted'),
    ).toBe('cancelled');
  });
});
