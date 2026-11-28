/**
 * Column geometry for foldable displays.
 *
 * UIKit reports where a display folds across a view (a division reserved
 * region). When a fold crosses a container, two columns keep their gutter on
 * it, so the fold never runs through a column; a container too narrow on
 * either side of the fold stays one column. Without a fold (the outer
 * display, a phone, an older system) two columns split the container evenly.
 */

/** A vertical fold across the container, in the container's coordinates. */
export type Fold = { x: number; width: number };

export type SplitInput = {
  /** Container width. */
  width: number;
  /** The fold crossing the container, if any. */
  fold: Fold | null;
  /** Space between the two columns. */
  gap: number;
  /** Narrowest acceptable column. */
  minColumn: number;
  /** Right-to-left layout puts the leading column on the right. */
  rtl?: boolean;
};

/**
 * Leading and trailing column widths and the space between them, or `null`
 * when one column fits best. Over a fold the gutter covers the fold, so it
 * can be wider than the requested gap.
 */
export type Split = { leading: number; gutter: number; trailing: number };

export function foldSplit({
  width,
  fold,
  gap,
  minColumn,
  rtl = false,
}: SplitInput): Split | null {
  if (!(width > 0)) return null;
  if (!fold) {
    if (width < minColumn * 2 + gap) return null;
    const half = (width - gap) / 2;
    return { leading: half, gutter: gap, trailing: half };
  }
  // The gutter covers the fold itself and is never narrower than `gap`.
  const gutter = Math.max(gap, fold.width);
  const center = fold.x + fold.width / 2;
  const left = center - gutter / 2;
  const right = width - center - gutter / 2;
  if (left < minColumn || right < minColumn) return null;
  return rtl
    ? { leading: right, gutter, trailing: left }
    : { leading: left, gutter, trailing: right };
}

/**
 * The fold that matters to a container's columns: a vertical division whose
 * centre lies inside the container. A horizontal fold (the display held the
 * other way) does not cross columns.
 */
export function crossingFold(
  folds: readonly { x: number; y: number; width: number; height: number }[],
  width: number,
): Fold | null {
  for (const fold of folds) {
    const center = fold.x + fold.width / 2;
    if (fold.height > fold.width && center > 0 && center < width)
      return { x: fold.x, width: fold.width };
  }
  return null;
}

/** How many tiles of at least `minTile` fit side by side in `width`. */
export function tilesPerRow(width: number, minTile: number, gap: number) {
  return Math.max(1, Math.floor((width + gap) / (minTile + gap)));
}

/**
 * Splits a list for two columns read top to bottom, then leading to trailing,
 * so reading order and VoiceOver order stay those of the single column.
 */
export function columnHalves<T>(items: readonly T[]): [T[], T[]] {
  const half = Math.ceil(items.length / 2);
  return [items.slice(0, half), items.slice(half)];
}

/** The hinge a display folds on: `none` where there is none or it is unknown. */
export type Hinge = 'none' | 'closed' | 'partlyOpen' | 'open';

export type ListDetailInput = {
  /** Container width. */
  width: number;
  /** The fold crossing the container, if any. */
  fold: Fold | null;
  /** The state of the hinge the display folds on. */
  hinge: Hinge;
  /** Space between the list and the detail. */
  gap: number;
  /** Narrowest acceptable list. */
  minList: number;
  /** Widest list, however wide the container. */
  maxList: number;
  /** Narrowest acceptable detail on a flat display. */
  minDetail: number;
  /** The list's share of the width, where the display lies flat. */
  share: number;
  /** Right-to-left layout puts the list on the right. */
  rtl?: boolean;
};

/**
 * A list beside its detail. Flat, the list takes `share` of the width (about
 * a third), within its limits; a display folded part way splits on its fold,
 * one side each, as two pages of a book. `null` when either side would be too
 * narrow: then the detail covers the list.
 */
export function listDetailSplit({
  width,
  fold,
  hinge,
  gap,
  minList,
  maxList,
  minDetail,
  share,
  rtl = false,
}: ListDetailInput): Split | null {
  if (!(width > 0)) return null;
  if (fold && hinge === 'partlyOpen') {
    const gutter = Math.max(gap, fold.width);
    const center = fold.x + fold.width / 2;
    const left = center - gutter / 2;
    const right = width - center - gutter / 2;
    const [list, detail] = rtl ? [right, left] : [left, right];
    // Each page of the book is narrower than a flat detail: both only need
    // to be as wide as a list.
    if (list < minList || detail < minList) return null;
    return { leading: list, gutter, trailing: detail };
  }
  const list = Math.round(
    Math.min(maxList, Math.max(minList, (width - gap) * share)),
  );
  const detail = width - gap - list;
  if (detail < minDetail) return null;
  return { leading: list, gutter: gap, trailing: detail };
}
