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

const version = (patch: Partial<VersionContent>): VersionContent => ({
  title: 'PR #261',
  body: null,
  url: null,
  card: null,
  reply: null,
  replyRound: 1,
  ...patch,
});

describe('the versions of a notification', () => {
  it('number them from the original, give each round its answer once, and name what changed', () => {
    const list = buildVersionList(
      version({
        body: 'All 14 checks passed.',
        card: { status: { label: 'CI passed', tone: 'success' } },
        reply: form('Merge now?'),
        replyRound: 2,
      }),
      [
        version({
          body: '2 checks failed.',
          card: { status: { label: 'CI failed', tone: 'danger' } },
          reply: form('Fix it?'),
        }),
        version({
          body: '2 checks failed.',
          card: { status: { label: 'Running', tone: 'info' } },
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
