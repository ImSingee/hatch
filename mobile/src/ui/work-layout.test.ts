import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../core';
import { transcriptRows, toolResultsByCall, workWords } from './work-layout';

const user = (text: string) => ({ role: 'user', content: text });
const call = (id: string, name = 'write_file') => ({
  type: 'toolCall',
  id,
  name,
  arguments: { path: 'src/App.tsx' },
});
const result = (id: string) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'write_file',
  content: [{ type: 'text', text: 'ok' }],
});
const run = (
  userTurn: number,
  status: 'completed' | 'failed' | 'cancelled' | 'running',
  completedAt: string | null = '2026-11-23T10:01:12.000Z',
) => ({
  id: `run-${userTurn}`,
  status,
  userTurn,
  startedAt: '2026-11-23T10:00:00.000Z',
  completedAt,
  error: null,
});

describe('transcript rows', () => {
  const messages: JsonValue[] = [
    user('Make a plant log'),
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Plan it.' }, call('a')],
      stopReason: 'toolUse',
    },
    result('a'),
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Writing it.' }, call('b')],
      stopReason: 'toolUse',
    },
    result('b'),
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'It is ready.' }],
      stopReason: 'stop',
    },
  ];

  it('folds a finished reply under one line and keeps its answer out', () => {
    const rows = transcriptRows(messages, [run(0, 'completed')]);
    expect(rows[0]).toEqual({ kind: 'speaker' });
    const segment = {
      key: 'run-0:0',
      phase: 'completed',
      startedAt: Date.parse('2026-11-23T10:00:00.000Z'),
      endedAt: Date.parse('2026-11-23T10:01:12.000Z'),
      steps: 2,
      hasProcess: true,
    };
    expect(rows.slice(1)).toEqual([
      { kind: 'reply', segment, leads: true, answerFrom: Infinity },
      { kind: 'reply', segment, leads: false, answerFrom: Infinity },
      { kind: 'reply', segment, leads: false, answerFrom: Infinity },
      { kind: 'reply', segment, leads: false, answerFrom: Infinity },
      { kind: 'reply', segment, leads: false, answerFrom: 0 },
    ]);
    expect(
      workWords({ phase: 'completed', elapsed: 72_000, steps: 2 }),
    ).toEqual({ lead: 'Worked', rest: ' for 1m 12s · 2 steps' });
  });

  it('keeps everything in the process while the run is working', () => {
    const rows = transcriptRows(messages.slice(0, 4), [
      run(0, 'running', null),
    ]);
    expect(
      rows.slice(1).map((row) => row.kind === 'reply' && row.answerFrom),
    ).toEqual([Infinity, Infinity, Infinity]);
    const first = rows[1];
    expect(first.kind === 'reply' && first.segment).toMatchObject({
      phase: 'running',
      endedAt: null,
      steps: 2,
    });
    expect(
      workWords({
        phase: 'running',
        elapsed: 42_000,
        steps: 2,
        current: 'Build the App',
      }),
    ).toEqual({ lead: 'Working', rest: ' for 42s · Build the App' });
  });

  it('names how a reply ended', () => {
    const reply = (stopReason: string) => [
      user('Go'),
      {
        role: 'assistant',
        content: [call('x'), { type: 'text', text: 'Partial.' }],
        stopReason,
      },
    ];
    const phase = (rows: ReturnType<typeof transcriptRows>) =>
      rows[1].kind === 'reply' ? rows[1].segment.phase : null;
    expect(phase(transcriptRows(reply('error'), [run(0, 'failed')]))).toBe(
      'failed',
    );
    expect(phase(transcriptRows(reply('stop'), [run(0, 'cancelled')]))).toBe(
      'cancelled',
    );
    expect(phase(transcriptRows(reply('length'), [run(0, 'completed')]))).toBe(
      'incomplete',
    );
    expect(workWords({ phase: 'failed', elapsed: 5_000, steps: 1 })).toEqual({
      lead: 'Failed',
      rest: ' after 5s · 1 step',
    });
    expect(workWords({ phase: 'cancelled', elapsed: null, steps: 0 })).toEqual({
      lead: 'Stopped',
      rest: '',
    });
  });

  it('splits a reply at a steered message and times each part', () => {
    const rows = transcriptRows(
      [
        user('Build it'),
        { role: 'assistant', content: [call('a')], stopReason: 'toolUse' },
        result('a'),
        {
          role: 'user',
          content: 'Use blue',
          steered: true,
          injectedAt: '2026-11-23T10:00:30.000Z',
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done in blue.' }],
          stopReason: 'stop',
        },
      ],
      [run(0, 'completed')],
    );
    expect(rows[3]).toEqual({ kind: 'speaker' });
    expect(rows[1].kind === 'reply' && rows[1].segment).toMatchObject({
      key: 'run-0:0',
      phase: 'completed',
      endedAt: Date.parse('2026-11-23T10:00:30.000Z'),
      steps: 1,
    });
    expect(rows[4]).toMatchObject({
      kind: 'reply',
      leads: true,
      answerFrom: 0,
      segment: {
        key: 'run-0:1',
        startedAt: Date.parse('2026-11-23T10:00:30.000Z'),
        steps: 0,
        hasProcess: false,
      },
    });
  });

  it('shows a reply from before runs were recorded without a time', () => {
    const rows = transcriptRows(messages, []);
    expect(rows[1].kind === 'reply' && rows[1].segment).toMatchObject({
      phase: 'completed',
      startedAt: null,
      endedAt: null,
    });
  });

  it('pairs only results whose call is in the transcript', () => {
    const results = toolResultsByCall([...messages, result('orphan')]);
    expect([...results.keys()]).toEqual(['a', 'b']);
  });
});
