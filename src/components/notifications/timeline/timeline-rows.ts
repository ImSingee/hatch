import type { NotificationSummaryView } from '~server/notifications';

/** A notification as the timeline shows it, oldest first. */
export type TimelineItem = NotificationSummaryView;

/**
 * Left behind where a notification was when its source updated it while the
 * page was open; the notification itself moved to the end.
 */
export type MovedMarker = {
  /** The notification that moved. */
  id: string;
  /** Its activity time after the move; a later move replaces the marker. */
  activityAt: string;
  sourceName: string;
  /** The notification it came after, or null when it was the first one. */
  afterId: string | null;
};

export type TimelineRow =
  | { kind: 'day'; key: string; date: string }
  | { kind: 'item'; key: string; item: TimelineItem }
  | { kind: 'quiet'; key: string; items: TimelineItem[] }
  | { kind: 'recalled'; key: string; item: TimelineItem }
  | { kind: 'moved'; key: string; sourceNames: string[] };

/** Low priority notifications that ask nothing share one collapsed row. */
function isQuiet(item: TimelineItem) {
  return item.priority < 0 && !item.reply && !item.recalledAt;
}

function dayOf(iso: string) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * Lay out the timeline: a divider before each new day, recalled notifications
 * as one line, runs of quiet notifications in one group, and the markers of
 * notifications that moved. A marker sits right before the notification that
 * used to follow the moved one, under that notification's day divider, so it
 * stays in the day it was in.
 */
export function buildTimelineRows(
  items: TimelineItem[],
  moved: MovedMarker[],
): TimelineRow[] {
  const markersAfter = new Map<string | null, MovedMarker[]>();
  for (const marker of moved) {
    const list = markersAfter.get(marker.afterId) ?? [];
    list.push(marker);
    markersAfter.set(marker.afterId, list);
  }
  const rows: TimelineRow[] = [];
  let day: string | null = null;
  // Markers wait for the next notification, so they land after its divider.
  let pending: MovedMarker[] = markersAfter.get(null) ?? [];
  const flushMarkers = () => {
    const markers = pending;
    pending = [];
    if (markers.length === 0) return;
    const previous = rows.at(-1);
    if (previous?.kind === 'moved') {
      previous.sourceNames.push(...markers.map((m) => m.sourceName));
    } else {
      rows.push({
        kind: 'moved',
        key: `moved:${markers[0]!.id}`,
        sourceNames: markers.map((m) => m.sourceName),
      });
    }
  };

  for (const item of items) {
    const itemDay = dayOf(item.activityAt);
    if (itemDay !== day) {
      day = itemDay;
      rows.push({ kind: 'day', key: `day:${itemDay}`, date: item.activityAt });
    }
    flushMarkers();
    const previous = rows.at(-1);
    if (isQuiet(item)) {
      if (previous?.kind === 'quiet') previous.items.push(item);
      else rows.push({ kind: 'quiet', key: `quiet:${item.id}`, items: [item] });
    } else if (item.recalledAt) {
      rows.push({ kind: 'recalled', key: item.id, item });
    } else {
      rows.push({ kind: 'item', key: item.id, item });
    }
    pending = [...pending, ...(markersAfter.get(item.id) ?? [])];
  }
  flushMarkers();
  return rows;
}

/**
 * The markers after the timeline went from `before` to `after`: a
 * notification whose activity time changed, and that was not already the last
 * one, leaves a marker where it was. Markers whose anchor is gone are dropped.
 */
export function nextMovedMarkers(
  before: TimelineItem[],
  after: TimelineItem[],
  markers: MovedMarker[],
): MovedMarker[] {
  const previous = new Map(before.map((item, index) => [item.id, index]));
  const present = new Set(after.map((item) => item.id));
  const added: MovedMarker[] = [];
  for (const item of after) {
    const index = previous.get(item.id);
    if (index === undefined) continue;
    const old = before[index]!;
    if (old.activityAt === item.activityAt || index === before.length - 1) {
      continue;
    }
    added.push({
      id: item.id,
      activityAt: item.activityAt,
      sourceName: item.sourceName,
      afterId: index > 0 ? before[index - 1]!.id : null,
    });
  }
  // A notification that followed another one that moved in the same update
  // marks the place the first one left, not the moved card itself.
  const addedById = new Map(added.map((marker) => [marker.id, marker]));
  for (const marker of added) {
    let anchor = marker.afterId;
    const seen = new Set<string>();
    while (anchor && addedById.has(anchor) && !seen.has(anchor)) {
      seen.add(anchor);
      anchor = addedById.get(anchor)!.afterId;
    }
    marker.afterId = anchor;
  }
  const replaced = new Set(added.map((marker) => marker.id));
  return [
    ...markers.filter(
      (marker) =>
        !replaced.has(marker.id) &&
        (marker.afterId === null || present.has(marker.afterId)),
    ),
    ...added,
  ];
}
