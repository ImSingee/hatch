import { Box, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { dashboardQueryOptions } from '~queries/dashboards';
import { DashboardGrid } from './dashboard-grid';

/**
 * In a peek the native home screen shows this page in a box of its own
 * height: only the widgets that fit whole are shown and the page does not
 * scroll, so no widget is cut by the box's edge. The first widget always
 * shows. The full page lists every widget.
 */
function usePeek(enabled: boolean) {
  // The canvas mounts only once its dashboard has loaded.
  const [main, setMain] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !main) return;
    const root = document.documentElement;
    root.style.overflow = 'hidden';
    const fit = () => {
      const limit = window.innerHeight;
      const cells = main.querySelectorAll<HTMLElement>('[data-widget-cell]');
      cells.forEach((cell, index) => {
        const hidden = index > 0 && cell.getBoundingClientRect().bottom > limit;
        // Opacity, not visibility: a widget's own content may set itself
        // visible again, and a hidden cell keeps its place in the grid.
        cell.style.opacity = hidden ? '0' : '';
        cell.inert = hidden;
        cell.toggleAttribute('aria-hidden', hidden);
      });
    };
    fit();
    // Widgets settle their size after mounting; refit whenever they do.
    const observer = new ResizeObserver(fit);
    observer.observe(main);
    const mutations = new MutationObserver(fit);
    mutations.observe(main, { childList: true, subtree: true });
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', fit);
      root.style.overflow = '';
    };
  }, [enabled, main]);
  return setMain;
}

/** Reuse the real widget runtime without exposing layout editing or navigation. */
export function MobileDashboardCanvas({
  dashboardId,
  peek = false,
}: {
  dashboardId: string;
  peek?: boolean;
}) {
  const peekRef = usePeek(peek);
  const data = useQuery(dashboardQueryOptions(dashboardId));
  const [refreshSignal, setRefreshSignal] = useState(0);
  const refetch = data.refetch;
  const refresh = useCallback(() => {
    void refetch();
    setRefreshSignal((value) => value + 1);
  }, [refetch]);

  // The native host owns the control and timer. Only refresh this canvas;
  // this command carries no credentials, URLs or executable payload.
  useEffect(() => {
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (
        detail &&
        typeof detail === 'object' &&
        'dashboardId' in detail &&
        detail.dashboardId === dashboardId
      )
        refresh();
    };
    window.addEventListener('hatch:dashboard-refresh', receive);
    return () => window.removeEventListener('hatch:dashboard-refresh', receive);
  }, [dashboardId, refresh]);

  if (data.isPending)
    return (
      <Center mih="60dvh" component="output" aria-label="Loading dashboard">
        <Loader size="sm" />
      </Center>
    );
  if (data.isError)
    return (
      <Stack p="lg" role="alert">
        <Text>Couldn’t load this dashboard.</Text>
        <Button type="button" onClick={refresh}>
          Try again
        </Button>
      </Stack>
    );

  return (
    <Box ref={peekRef} p="sm" component="main" aria-label="Dashboard canvas">
      {data.data.widgets.length === 0 ? (
        <Stack align="center" justify="center" p="xl" mih="60dvh" gap="sm">
          <Text size="xl" fw={700}>
            No widgets yet
          </Text>
          <Text c="dimmed" ta="center">
            Add widgets to this dashboard from Hatch on the web.
          </Text>
        </Stack>
      ) : (
        <DashboardGrid
          items={data.data.widgets}
          layouts={data.data.layouts}
          editing={false}
          onRemove={() => {}}
          onLayoutCommit={() => {}}
          refreshSignal={refreshSignal}
          nativeHost
        />
      )}
    </Box>
  );
}
