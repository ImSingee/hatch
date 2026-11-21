import { Center, Loader } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { useMemo } from 'react';
import { GridLayout, type Layout } from 'react-grid-layout';
import {
  transformStrategy,
  verticalCompactor,
  type DragConfig,
  type GridConfig,
  type ResizeConfig,
} from 'react-grid-layout/core';
import type { DashboardItem } from '~server/dashboards';
import {
  DASHBOARD_COLUMNS,
  dashboardBreakpointForWidth,
  placeDashboardLayoutItem,
  supportedSizesForBreakpoint,
  DASHBOARD_MAX_Y,
  type DashboardBreakpoint,
  type DashboardLayoutItem,
  type DashboardLayouts,
} from '~/lib/dashboard-layout';
import { buildWidgetLayout } from './dashboard-layout';
import { WidgetCard } from './widget-card';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import classes from './dashboard-grid.module.css';

/** Height of one grid row, in px. */
export const WIDGET_ROW_HEIGHT = 80;
/** Gap between rows on the mobile grid, in px. */
export const WIDGET_ROW_GAP = 14;

export function DashboardGrid({
  items,
  layouts,
  editing,
  previewBreakpoint,
  onRemove,
  onLayoutCommit,
  removeDisabled = false,
  interactionDisabled = false,
  transformScale = 1,
  refreshSignal,
  nativeHost = false,
}: {
  items: DashboardItem[];
  layouts: DashboardLayouts;
  editing: boolean;
  previewBreakpoint?: DashboardBreakpoint;
  onRemove: (id: string) => void;
  onLayoutCommit: (
    breakpoint: DashboardBreakpoint,
    layout: DashboardLayoutItem[],
  ) => void;
  removeDisabled?: boolean;
  interactionDisabled?: boolean;
  transformScale?: number;
  /** Bumped by dashboard-wide manual or automatic refreshes. */
  refreshSignal?: number;
  /**
   * Rendered inside the native app's WebView. The host owns refresh controls,
   * and Open app is a document link that the host intercepts before it loads,
   * so the embedded router and history never change.
   */
  nativeHost?: boolean;
}) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const breakpoint = previewBreakpoint ?? dashboardBreakpointForWidth(width);
  const activeLayout = layouts[breakpoint];

  const layout = useMemo<Layout>(
    () => buildWidgetLayout(items, activeLayout, breakpoint),
    [activeLayout, breakpoint, items],
  );
  const interactionsEnabled = editing && !interactionDisabled;
  const gridConfig = useMemo<Partial<GridConfig>>(
    () => ({
      cols: DASHBOARD_COLUMNS[breakpoint],
      rowHeight: WIDGET_ROW_HEIGHT,
      margin:
        breakpoint === 'mobile' ? [WIDGET_ROW_GAP, WIDGET_ROW_GAP] : [16, 16],
      containerPadding: [0, 0],
    }),
    [breakpoint],
  );
  const dragConfig = useMemo<Partial<DragConfig>>(
    () => ({
      enabled: interactionsEnabled,
      bounded: true,
      handle: '.widget-drag-handle',
      cancel: '.widget-no-drag',
    }),
    [interactionsEnabled],
  );
  const resizeConfig = useMemo<Partial<ResizeConfig>>(
    () => ({ enabled: interactionsEnabled }),
    [interactionsEnabled],
  );
  const positionStrategy = useMemo(
    () => ({ ...transformStrategy, scale: transformScale }),
    [transformScale],
  );
  const geometryById = useMemo(
    () => new Map(activeLayout.map((item) => [item.id, item])),
    [activeLayout],
  );

  // Size buttons and keyboard moves place one item the way a drop does:
  // whatever it lands on moves down, then rows close up.
  const place = (item: DashboardLayoutItem) =>
    onLayoutCommit(breakpoint, placeDashboardLayoutItem(activeLayout, item));
  const move = (geometry: DashboardLayoutItem, dx: number, dy: number) => {
    const columns = DASHBOARD_COLUMNS[breakpoint];
    const x = Math.min(columns - geometry.w, Math.max(0, geometry.x + dx));
    const y = Math.min(DASHBOARD_MAX_Y, Math.max(0, geometry.y + dy));
    if (x === geometry.x && y === geometry.y) return;
    place({ ...geometry, x, y });
  };

  const commit = (next: Layout) =>
    onLayoutCommit(
      breakpoint,
      next.map((item) => ({
        id: item.i,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      })),
    );

  return (
    <div
      ref={ref}
      className={classes.measure}
      data-breakpoint={breakpoint}
      data-editing={editing || undefined}
    >
      {width > 0 ? (
        <GridLayout
          className={classes.grid}
          width={width}
          layout={layout}
          gridConfig={gridConfig}
          dragConfig={dragConfig}
          resizeConfig={resizeConfig}
          positionStrategy={positionStrategy}
          compactor={verticalCompactor}
          onDragStop={commit}
          onResizeStop={commit}
        >
          {items.map((item) => {
            const geometry = geometryById.get(item.id);
            if (!geometry) return null;
            return (
              <div key={item.id} className={classes.cell}>
                <WidgetCard
                  item={item}
                  geometry={geometry}
                  editing={editing}
                  removeDisabled={removeDisabled}
                  onRemove={() => onRemove(item.id)}
                  refreshSignal={refreshSignal}
                  nativeHost={nativeHost}
                  sizes={supportedSizesForBreakpoint(
                    item.supportedSizes,
                    breakpoint,
                  )}
                  onSizeChange={(size) =>
                    place({
                      ...geometry,
                      ...size,
                      x: Math.min(
                        geometry.x,
                        DASHBOARD_COLUMNS[breakpoint] - size.w,
                      ),
                    })
                  }
                  onMove={(dx, dy) => move(geometry, dx, dy)}
                />
              </div>
            );
          })}
        </GridLayout>
      ) : (
        <Center py={64}>
          <Loader size="sm" />
        </Center>
      )}
    </div>
  );
}
