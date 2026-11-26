import { View, computed, signal, token } from 'nsh';
import type { JSX, Tokens } from 'nsh';
import { DataTable as BaseDataTable } from 'nsh/base';
import type { DataTableColumn as BaseColumn, DataTableSort } from 'nsh/base';
import {
  COLUMN_WIDTH,
  TABLE_FONT_SIZE,
  TABLE_HEADER_HEIGHT,
  TABLE_ROW_HEIGHT,
} from '../core/metrics';
import { Spinner } from './Spinner';
import { Text } from './Text';

export type DataTableColumn<T> = {
  /** The row field the column shows. */
  key: keyof T & string;
  title: string;
  /** `xs` 72 to `xl` 320 points; default fits the content. */
  width?: keyof typeof COLUMN_WIDTH;
  /** `end` for numbers and amounts. */
  align?: 'start' | 'center' | 'end';
  /** Lets the user sort by this column. */
  sortable?: boolean;
  /** Turns a field into the text shown, such as a date or an amount. */
  format?: (value: T[keyof T & string], row: T) => string;
  /** Keeps the column in place while the others scroll sideways. */
  fixed?: boolean;
};

export type DataTableProps<T> = {
  /** What the table lists, for screen readers: "Expenses". */
  label: string;
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  /** A row was pressed: open it. */
  onRowPress?: (row: T) => void;
  /** Rows the table shows before it scrolls; default 10. */
  visibleRows?: 5 | 10 | 15 | 20;
  /** Shows a spinner in place of rows that have not loaded yet. */
  loading?: boolean;
  /** One line shown when there are no rows. */
  empty?: string;
};

type Sort = { key: string; direction: 'ascending' | 'descending' };

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a ?? '').localeCompare(String(b ?? ''));
}

const CLASSES = {
  root: 'bg-card',
  header: 'bg-muted border-b border-hairline',
  headerCell: 'px-3 justify-center',
  headerContent: 'text-caption font-label text-muted-foreground',
  headerCellSorted: 'text-foreground',
  sortIndicator: 'text-muted-foreground',
  row: 'border-b border-hairline',
  rowHover: 'bg-surface-hover',
  rowSelected: 'bg-primary-tint',
  rowActive: 'bg-surface-pressed',
  cell: 'px-3 justify-center text-body text-foreground',
  cellActive: 'outline-2 -outline-offset-2 outline-ring',
  fixedEdge: 'border-r border-hairline',
  resizeHandle: 'bg-hairline',
};

/**
 * Rows of records in columns, for data people compare and sort. It scrolls
 * sideways in narrow panes and down past `visibleRows`.
 */
export function DataTable<T extends object>(
  props: DataTableProps<T>,
): JSX.Element {
  const sort = signal<Sort | null>(null);
  const sorted = computed(() => {
    const current = sort();
    if (!current) return props.rows;
    const factor = current.direction === 'ascending' ? 1 : -1;
    return [...props.rows].sort(
      (a, b) =>
        factor *
        compare(
          (a as Record<string, unknown>)[current.key],
          (b as Record<string, unknown>)[current.key],
        ),
    );
  });
  const data = computed(() =>
    sorted().map((row) =>
      Object.fromEntries(
        props.columns.map((column) => [
          column.key,
          column.format
            ? column.format(row[column.key], row)
            : String(row[column.key] ?? ''),
        ]),
      ),
    ),
  );
  const columns = (): BaseColumn[] =>
    props.columns.map((column) => ({
      key: column.key,
      title: column.title,
      width: column.width ? COLUMN_WIDTH[column.width] : null,
      minWidth: COLUMN_WIDTH.xs,
      align: column.align ?? 'start',
      sortable: column.sortable ?? false,
      fixed: column.fixed ?? false,
    }));
  const height = () =>
    TABLE_HEADER_HEIGHT +
    TABLE_ROW_HEIGHT *
      Math.max(1, Math.min(props.rows.length, props.visibleRows ?? 10));
  return (
    <View
      class="self-stretch overflow-hidden rounded-(--radius-lg) border border-hairline bg-card"
      style={{ height: height() }}
    >
      <BaseDataTable
        class="flex-1"
        accessibilityLabel={props.label}
        columns={columns()}
        data={data()}
        rowHeight={TABLE_ROW_HEIGHT}
        headerHeight={TABLE_HEADER_HEIGHT}
        fontFamily={token('font-sans' as keyof Tokens) as string}
        fontSize={TABLE_FONT_SIZE}
        rowSelectable={props.onRowPress !== undefined}
        columnSelectable={false}
        cellSelectable={false}
        loading={props.loading}
        sort={
          sort()
            ? ({
                key: sort()?.key,
                direction: sort()?.direction,
              } as DataTableSort)
            : null
        }
        onSortChange={(event) =>
          sort.set(
            event.sort
              ? {
                  key: event.sort.key,
                  direction:
                    event.sort.direction === 'descending'
                      ? 'descending'
                      : 'ascending',
                }
              : null,
          )
        }
        onRowPress={(event) => {
          const row = sorted()[event.row];
          if (row && props.onRowPress) props.onRowPress(row);
        }}
        classes={CLASSES}
        loadingView={
          <View class="flex-1 items-center justify-center p-4">
            <Spinner size="lg" color="muted-foreground" />
          </View>
        }
        empty={
          <View class="flex-1 items-center justify-center p-4">
            <Text tone="muted">{props.empty ?? 'Nothing here yet.'}</Text>
          </View>
        }
      />
    </View>
  );
}
