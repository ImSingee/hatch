import { View } from 'nsh';
import type { JSX } from 'nsh';
import { paneSize } from '../core/env';
import { ALIGN, GAP, JUSTIFY } from '../core/styles';
import type { Align, Justify, Space } from '../core/types';

export type StackProps = {
  children?: JSX.Element;
  /** Space between children; default `md` (12 points). */
  gap?: Space;
  /** Cross-axis alignment; default `stretch`. */
  align?: Align;
  justify?: Justify;
  /** Takes the space left in its parent. */
  grow?: boolean;
};

/** Children in a column. */
export function Stack(props: StackProps): JSX.Element {
  return (
    <View
      class={[
        'flex-col',
        GAP[props.gap ?? 'md'],
        ALIGN[props.align ?? 'stretch'],
        JUSTIFY[props.justify ?? 'start'],
        props.grow ? 'flex-1' : '',
      ].join(' ')}
    >
      {props.children}
    </View>
  );
}

export type RowProps = {
  children?: JSX.Element;
  /** Space between children; default `sm` (8 points). */
  gap?: Space;
  /** Cross-axis alignment; default `center`. */
  align?: Align;
  justify?: Justify;
  /** Wraps children onto more lines when they do not fit. */
  wrap?: boolean;
  /** Becomes a column in a compact pane (narrower than 600 points). */
  collapse?: boolean;
  grow?: boolean;
};

/** Children in a row. */
export function Row(props: RowProps): JSX.Element {
  const column = () => props.collapse === true && paneSize() === 'compact';
  return (
    <View
      class={[
        column() ? 'flex-col' : 'flex-row',
        GAP[props.gap ?? 'sm'],
        column() ? ALIGN.stretch : ALIGN[props.align ?? 'center'],
        JUSTIFY[props.justify ?? 'start'],
        props.wrap ? 'flex-wrap' : '',
        props.grow ? 'flex-1' : '',
      ].join(' ')}
    >
      {props.children}
    </View>
  );
}

export type GridProps = {
  children?: JSX.Element;
  /** Columns in a wide pane. A medium pane shows at most two and a compact
   * pane one. Default 2. */
  columns?: 1 | 2 | 3 | 4;
  /** Columns in a compact pane; default 1. Two suit small tiles such as
   * `Stat`s. */
  compactColumns?: 1 | 2;
  /** Default `lg` (16 points). */
  gap?: Space;
};

const COLUMNS: Record<1 | 2 | 3 | 4, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

/** Children in equal columns that follow the pane's width. */
export function Grid(props: GridProps): JSX.Element {
  const columns = (): 1 | 2 | 3 | 4 => {
    const wanted = props.columns ?? 2;
    const size = paneSize();
    if (size === 'compact')
      return Math.min(wanted, props.compactColumns ?? 1) as 1 | 2;
    if (size === 'medium') return wanted > 2 ? 2 : wanted;
    return wanted;
  };
  return (
    <View class={`grid ${COLUMNS[columns()]} ${GAP[props.gap ?? 'lg']}`}>
      {props.children}
    </View>
  );
}
