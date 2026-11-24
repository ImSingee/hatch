import { describe, expect, it } from 'vitest';
import {
  buildTimelineRows,
  nextMovedMarkers,
  type TimelineItem,
} from './timeline-rows';

function item(
  id: string,
  activityAt: string,
  extra: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    id,
    sourceType: 'channel',
    sourceId: 'c1',
    sourceName: 'GitHub',
    kind: 'pr',
    kindName: 'Pull request',
    title: `Title ${id}`,
    body: null,
    url: null,
    autoOpenUrl: false,
    priority: 0,
    occurredAt: activityAt,
    createdAt: activityAt,
    activityAt,
    revision: 1,
    editedAt: null,
    recalledAt: null,
    reply: null,
    respondedAt: null,
    response: null,
    status: 'delivered',
    deliveries: { pending: 0, succeeded: 1, failed: 0, canceled: 0 },
    ...extra,
  };
}

const kinds = (rows: ReturnType<typeof buildTimelineRows>) =>
  rows.map((row) =>
    row.kind === 'item' || row.kind === 'recalled'
      ? `${row.kind}:${row.item.id}`
      : row.kind === 'quiet'
        ? `quiet:${row.items.map((entry) => entry.id).join('+')}`
        : row.kind === 'moved'
          ? `moved:${row.sourceNames.length}`
          : 'day',
  );

describe('timeline rows', () => {
  it('starts each day with a divider, groups quiet runs and shows recalls as lines', () => {
    const rows = buildTimelineRows(
      [
        item('a', '2026-11-24T09:00:00'),
        item('b', '2026-11-24T17:00:00', { priority: -1 }),
        item('c', '2026-11-24T17:05:00', { priority: -2 }),
        item('d', '2026-11-25T08:30:00', { recalledAt: '2026-11-25T08:40:00' }),
        // A quiet notification that asks something stays a card.
        item('e', '2026-11-25T09:00:00', {
          priority: -1,
          reply: { fields: [], submitLabel: 'Submit' },
        }),
      ],
      [],
    );
    expect(kinds(rows)).toEqual([
      'day',
      'item:a',
      'quiet:b+c',
      'day',
      'recalled:d',
      'item:e',
    ]);
  });

  it('leaves one marker where an updated notification was, and merges neighbours', () => {
    const before = [
      item('a', '2026-11-25T09:00:00'),
      item('b', '2026-11-25T09:10:00'),
      item('c', '2026-11-25T09:20:00'),
      item('d', '2026-11-25T09:30:00'),
    ];
    // `a` and `b` were updated and moved to the end; `d` was already last.
    const after = [
      before[2]!,
      item('d', '2026-11-25T10:05:00'),
      item('a', '2026-11-25T10:00:00'),
      item('b', '2026-11-25T10:01:00'),
    ];
    const markers = nextMovedMarkers(before, after, []);
    // `b` followed `a`, which moved too, so both mark where `a` was.
    expect(markers.map((marker) => [marker.id, marker.afterId])).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(kinds(buildTimelineRows(after, markers))).toEqual([
      'day',
      'moved:2',
      'item:c',
      'item:d',
      'item:a',
      'item:b',
    ]);

    // A second update of `a` replaces its marker instead of adding one.
    const later = [
      after[0]!,
      after[1]!,
      after[3]!,
      item('a', '2026-11-25T11:00:00'),
    ];
    const next = nextMovedMarkers(after, later, markers);
    expect(next.filter((marker) => marker.id === 'a')).toHaveLength(1);
  });

  it("keeps a marker in the day it was in, under that day's divider", () => {
    const before = [
      item('y', '2026-11-24T18:00:00'),
      item('a', '2026-11-25T09:00:00'),
      item('b', '2026-11-25T09:10:00'),
    ];
    const after = [before[0]!, before[2]!, item('a', '2026-11-25T10:00:00')];
    const markers = nextMovedMarkers(before, after, []);
    expect(kinds(buildTimelineRows(after, markers))).toEqual([
      'day',
      'item:y',
      'day',
      'moved:1',
      'item:b',
      'item:a',
    ]);
  });

  it('puts the unread divider under the day divider of the first unread notification', () => {
    const rows = buildTimelineRows(
      [
        item('a', '2026-11-24T18:00:00'),
        item('b', '2026-11-25T09:00:00'),
        item('c', '2026-11-25T09:10:00'),
      ],
      [],
      'b',
    );
    expect(rows.map((row) => row.kind)).toEqual([
      'day',
      'item',
      'day',
      'unread',
      'item',
      'item',
    ]);
  });

  it('drops a marker once the notification it followed is gone', () => {
    const before = [
      item('a', '2026-11-25T09:00:00'),
      item('b', '2026-11-25T09:10:00'),
      item('c', '2026-11-25T09:20:00'),
    ];
    const after = [before[0]!, before[2]!, item('b', '2026-11-25T10:00:00')];
    const markers = nextMovedMarkers(before, after, []);
    expect(markers).toHaveLength(1);
    expect(nextMovedMarkers(after, [after[1]!, after[2]!], markers)).toEqual(
      [],
    );
  });
});
