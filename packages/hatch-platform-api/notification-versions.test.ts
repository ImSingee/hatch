import { describe, expect, it } from 'vitest';
import { buildVersionList, type VersionContent } from './notification-versions';

const form = (label: string) => ({
  fields: [
    {
      id: 'decision',
      type: 'buttons' as const,
      label,
      required: true,
      options: [
        { id: 'yes', label: 'Yes', destructive: false },
        { id: 'no', label: 'No', destructive: false },
      ],
    },
  ],
  submitLabel: 'Send',
});

const status = (label: string, tone: string) => ({
  type: 'Card',
  props: { status: label, tone },
  children: [{ type: 'Title', children: ['PR #261'] }],
});

const version = (patch: Partial<VersionContent>): VersionContent => ({
  format: 'text',
  title: 'PR #261',
  body: null,
  summary: null,
  content: null,
  url: null,
  reply: null,
  replyRound: 1,
  ...patch,
});

describe('the versions of a notification', () => {
  it('number them from the original, give each round its answer once, and name what changed', () => {
    const list = buildVersionList(
      version({
        body: 'All 14 checks passed.',
        format: 'card',
        title: null,
        summary: 'PR #261',
        content: status('CI passed', 'success'),
        reply: form('Merge now?'),
        replyRound: 2,
      }),
      [
        version({
          body: '2 checks failed.',
          format: 'card',
          title: null,
          summary: 'PR #261',
          content: status('CI failed', 'danger'),
          reply: form('Fix it?'),
        }),
        version({
          body: '2 checks failed.',
          format: 'card',
          title: null,
          summary: 'PR #261',
          content: status('Running', 'info'),
          reply: form('Fix it?'),
        }),
      ],
      { total: 3 },
    );
    expect(list.map((entry) => entry.number)).toEqual([3, 2, 1]);
    expect(list.map((entry) => entry.current)).toEqual([true, false, false]);
    // Round 1 ran through two versions; its answer shows on the later one.
    expect(list.map((entry) => entry.lastOfRound)).toEqual([true, true, false]);
    expect(list[0]!.changes).toEqual(['status', 'body', 'question']);
    expect(list[1]!.changes).toEqual(['status']);
    expect(list[2]!.changes).toEqual([]);
  });

  it('name nothing for the oldest loaded version while older pages remain', () => {
    const list = buildVersionList(
      version({ title: 'Deploy #88' }),
      [version({ title: 'Deploy #88 queued' })],
      { total: 5 },
    );
    expect(list.map((entry) => entry.number)).toEqual([5, 4]);
    expect(list[1]!.changes).toEqual([]);
  });

  it('tell a format switch, a new summary and new content apart from a new status', () => {
    const card = version({
      format: 'card',
      title: null,
      summary: 'CI failed',
      content: status('CI failed', 'danger'),
    });
    const text = version({ title: 'CI failed', body: '2 checks failed.' });
    expect(buildVersionList(card, [text], { total: 2 })[0]!.changes).toEqual([
      'status',
      'format',
      'title',
      'summary',
      'body',
      'content',
    ]);
    // jsonb hands trees back with their keys reordered: not a change.
    const stored = {
      ...card,
      content: {
        children: card.content!.children,
        props: { tone: 'danger', status: 'CI failed' },
        type: 'Card',
      },
    };
    expect(buildVersionList(stored, [card], { total: 2 })[0]!.changes).toEqual(
      [],
    );
  });

  it('report a removed question, and data only when asked to compare it', () => {
    const newer = version({ replyRound: 2, data: { step: 3 } });
    const older = version({ reply: form('Ship?'), data: { step: 1 } });
    expect(buildVersionList(newer, [older], { total: 2 })[0]!.changes).toEqual([
      'questionRemoved',
    ]);
    expect(
      buildVersionList(newer, [older], { total: 2, compareData: true })[0]!
        .changes,
    ).toEqual(['data', 'questionRemoved']);
  });
});
