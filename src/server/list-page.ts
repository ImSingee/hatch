/**
 * Offset paging for the short, user-ordered lists the public API returns
 * whole by default (pins, dashboards). The cursor is the offset of the first
 * entry of the next page, as a decimal string; a limit of 0 returns every
 * entry from the cursor on. Pages reflect the order at the time of each call,
 * so a reorder between calls can repeat or skip an entry.
 */
export function listPage<T>(
  items: readonly T[],
  request: { cursor?: string; limit: number },
): { items: T[]; nextCursor?: string } {
  const start = request.cursor ? Number(request.cursor) : 0;
  const end = request.limit ? start + request.limit : items.length;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : undefined,
  };
}
