import {
  Fragment,
  useCallback,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  I18nManager,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { FoldProbe } from './fold-probe';
import type { FoldRect } from './fold-probe.types';
import {
  columnHalves,
  crossingFold,
  foldSplit,
  listDetailSplit,
  tilesPerRow,
  type Split,
} from './fold-split';

/**
 * Measures a container and splits it into two columns around the display's
 * fold (see `foldSplit`). Sizes come from the container, never the screen:
 * the same page runs on the outer and inner displays, beside another app, and
 * under a vertical bar, and any of those can change while it is open.
 */
export function useFoldSplit({
  minColumn,
  gap,
}: {
  minColumn: number;
  gap: number;
}) {
  const [width, setWidth] = useState(0);
  const [folds, setFolds] = useState<FoldRect[]>([]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const fold = crossingFold(folds, width);
  const split: Split | null = foldSplit({
    width,
    fold,
    gap,
    minColumn,
    rtl: I18nManager.isRTL,
  });
  return { onLayout, onFolds: setFolds, width, split };
}

/**
 * The geometry of a list beside its detail (`listDetailSplit`): a list such
 * as Apps or conversations, about a third of the width, and what it opens.
 */
export const listDetail = {
  gap: 16,
  minList: 260,
  maxList: 360,
  minDetail: 400,
  share: 1 / 3,
} as const;

/**
 * Measures a container and splits it into a list and its detail (see
 * `listDetailSplit`): on the fold where the system reports one, else by
 * width. Sizes come from the container, never the
 * screen, so a window beside another app or a narrow pane gets one column.
 */
export function useListDetail(
  options: Omit<
    Parameters<typeof listDetailSplit>[0],
    'width' | 'fold' | 'rtl'
  > = listDetail,
) {
  const [width, setWidth] = useState(0);
  const [folds, setFolds] = useState<FoldRect[]>([]);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width),
    [],
  );
  const split = listDetailSplit({
    ...options,
    width,
    fold: crossingFold(folds, width),
    rtl: I18nManager.isRTL,
  });
  return { onLayout, onFolds: setFolds, width, split };
}

/** A container that measures itself and the fold across it. */
export function FoldContainer({
  onLayout,
  onFolds,
  style,
  children,
}: PropsWithChildren<{
  onLayout: (event: LayoutChangeEvent) => void;
  onFolds: (folds: FoldRect[]) => void;
  style?: StyleProp<ViewStyle>;
}>) {
  return (
    <View onLayout={onLayout} style={style}>
      {children}
      {/* Last: native tabs look for a page's scroll view along first children.
          It is transparent and never takes touches. */}
      <FoldProbe onFolds={onFolds} />
    </View>
  );
}

/**
 * A list beside its detail when both fit (`useListDetail`), otherwise the
 * detail alone. The detail keeps its place as the list comes and goes, so
 * folding, unfolding or resizing never reloads what it shows.
 */
export function ListDetail({
  list,
  children,
}: PropsWithChildren<{
  /** The list, shown only beside the detail. */
  list: ReactNode;
}>) {
  const { onLayout, onFolds, width, split } = useListDetail();
  return (
    <FoldContainer
      onLayout={onLayout}
      onFolds={onFolds}
      style={{ flex: 1, flexDirection: 'row' }}
    >
      {split ? <View style={{ width: split.leading }}>{list}</View> : null}
      {/* Alone, the detail takes the measured width rather than `flex: 1`:
          dropping the list's `width` and `marginStart` for `flex: 1` left a
          native App at its two-column width after folding the display. */}
      <View
        style={
          split
            ? { width: split.trailing, marginStart: split.gutter }
            : width
              ? { width, marginStart: 0 }
              : { flex: 1 }
        }
      >
        {children}
      </View>
    </FoldContainer>
  );
}

/**
 * A list that reflows into two columns when there is room for both, the
 * second column continuing the first.
 */
export function Reflow<T>({
  items,
  render,
  minColumn = 320,
  gap = 12,
}: {
  items: readonly T[];
  /** Renders one column; the two columns share the list's shape. */
  render: (items: T[]) => ReactNode;
  minColumn?: number;
  gap?: number;
}) {
  const { onLayout, onFolds, split } = useFoldSplit({ minColumn, gap });
  const [first, second] = columnHalves(items);
  return (
    <FoldContainer
      onLayout={onLayout}
      onFolds={onFolds}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: split?.gutter ?? gap,
      }}
    >
      {split && second.length ? (
        <>
          <View style={{ width: split.leading }}>{render(first)}</View>
          <View style={{ width: split.trailing }}>{render(second)}</View>
        </>
      ) : (
        <View style={{ flex: 1 }}>{render([...items])}</View>
      )}
    </FoldContainer>
  );
}

/**
 * Two blocks side by side when both fit, otherwise the leading block above
 * the trailing one.
 */
export function Columns({
  leading,
  trailing,
  minColumn = 320,
  gap = 12,
}: {
  leading: ReactNode;
  trailing: ReactNode;
  minColumn?: number;
  gap?: number;
}) {
  const { onLayout, onFolds, split } = useFoldSplit({ minColumn, gap });
  return (
    <FoldContainer
      onLayout={onLayout}
      onFolds={onFolds}
      style={
        split
          ? {
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: split.gutter,
            }
          : undefined
      }
    >
      <View style={split ? { width: split.leading } : undefined}>
        {leading}
      </View>
      <View style={split ? { width: split.trailing } : undefined}>
        {trailing}
      </View>
    </FoldContainer>
  );
}

/**
 * Tiles in rows across the container's whole width, starting at the leading
 * edge. A fold across the grid is ignored: tiles run straight across it, the
 * way the system home screen lays out icons on an unfolded display.
 */
export function TileGrid<T>({
  items,
  keyOf,
  render,
  minTile,
  gap = 10,
}: {
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, width: number) => ReactNode;
  minTile: number;
  gap?: number;
}) {
  const [width, setWidth] = useState(0);
  const perRow = tilesPerRow(width, minTile, gap);
  const tile = (width - gap * (perRow - 1)) / perRow;
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += perRow)
    rows.push(items.slice(index, index + perRow));
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ gap }}
    >
      {width
        ? rows.map((row) => (
            <View
              key={row.map(keyOf).join()}
              style={{ flexDirection: 'row', gap }}
            >
              {row.map((item) => (
                <Fragment key={keyOf(item)}>{render(item, tile)}</Fragment>
              ))}
            </View>
          ))
        : null}
    </View>
  );
}
