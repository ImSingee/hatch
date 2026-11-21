import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSession } from '../state/session';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { useAccent } from '../ui/accent';
import { FoldContainer, TileGrid, useFoldSplit } from '../ui/columns';
import { Glyph } from '../ui/glyph';
import { Busy, Notice, errorText } from '../ui/primitives';
import { AddTile, AppTile, ShortcutTile } from '../ui/rows';
import {
  Masthead,
  PageRoot,
  SectionLabel,
  pageScrollProps,
} from '../ui/screen';
import { Text, type } from '../ui/text';
import {
  DashboardNotices,
  DashboardPager,
  DashboardRefresh,
  WidgetSheet,
  useDashboards,
} from './dashboard';

const TILE = 60;
const GUTTER = 20;

function greeting(hour: number) {
  return hour < 5
    ? 'Good evening'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';
}

/**
 * The home screen: the widgets of a dashboard in a sheet, paged by dashboard,
 * over the grid of pinned Apps and Workflows. With room for two columns the
 * widgets take the leading one and the pins the trailing one, split on the
 * fold.
 */
export function HomeScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const accent = useAccent();
  const focused = useIsFocused();
  const { fontScale } = useWindowDimensions();
  const queryClient = useQueryClient();
  const lifetime = useLifetimeSignal();
  const board = useDashboards(focused);
  const { onLayout, onFolds, split, width } = useFoldSplit({
    minColumn: 320,
    gap: GUTTER,
  });
  // The page's own height, so the widget sheet fills a wide page's column.
  const [height, setHeight] = useState(0);
  const [opened] = useState(() => Date.now());
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
  const pinned = useQuery({
    queryKey: [origin, 'pins'],
    queryFn: ({ signal }) => api!.pins(signal),
    enabled: Boolean(api),
  });
  const workspace = board.workspace;
  const pull = usePullToRefresh(focused, () => {
    board.refreshWidgets();
    return Promise.all([workspace.refetch(), apps.refetch(), pinned.refetch()]);
  });
  const appById = new Map((apps.data ?? []).map((item) => [item.id, item]));
  const pins = (pinned.data?.apps ?? []).filter(
    (pin) => pin.appStatus !== 'archived',
  );
  const pinnedWorkflows = pinned.data?.workflows ?? [];
  // Pins are shared by every client: a change re-reads them, and the lists
  // that mark pinned rows.
  const changed = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [origin, 'pins'] }),
      queryClient.invalidateQueries({ queryKey: [origin, 'workspace'] }),
    ]);
  const unpin = useMutation({
    mutationFn: (target: { pinId: string } | { workflowId: string }) =>
      'pinId' in target
        ? api!.unpinApp(target.pinId, lifetime())
        : api!.setWorkflowPinned(target.workflowId, false, lifetime()),
    onSettled: changed,
  });
  const askUnpin = (
    name: string,
    target: { pinId: string } | { workflowId: string },
  ) =>
    Alert.alert(`Unpin ${name}?`, 'It stays in Apps and can be pinned again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpin',
        style: 'destructive',
        onPress: () => unpin.mutate(target),
      },
    ]);
  const pending = pinned.isPending;
  const failure = pinned.error ?? unpin.error;
  // Dated by the last read of the workspace, so the greeting follows the
  // clock on every refresh without reading it while rendering.
  const now = new Date(workspace.dataUpdatedAt || opened);
  const today = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const column = split ? split.leading : width;
  const sheetHeight = split
    ? Math.max(280, height - 210)
    : Math.min(300, Math.max(210, column * 0.62));
  // Large text needs wider tiles for their one-line labels.
  const tile = { minTile: fontScale > 1.3 ? 104 : 76, gap: 8 };

  const widgets = (
    <View>
      <View style={{ marginHorizontal: -GUTTER }}>
        <Masthead
          eyebrow={today}
          title={greeting(now.getHours())}
          nested={nested}
          actions={<DashboardRefresh board={board} />}
        />
      </View>
      <View style={{ gap: 12 }}>
        <DashboardNotices board={board} />
        <WidgetSheet board={board} style={{ height: sheetHeight }} />
      </View>
      <View
        style={{
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <Text style={[type.small, { flex: 1 }]} numberOfLines={1}>
          {board.dashboards.length > 1 ? board.current?.name : ''}
        </Text>
        <DashboardPager board={board} />
        <View style={{ flex: 1, alignItems: 'flex-end' }}>
          {board.current ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel="All widgets"
              accessibilityHint="Shows this dashboard at full height"
              onPress={() =>
                router.push({
                  pathname: '/library',
                  params: { kind: 'widgets', dashboard: board.current!.id },
                })
              }
              style={({ pressed }) => ({
                minHeight: 44,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={[type.small, { color: accent.ink }]}>
                All widgets
              </Text>
              <Glyph name="chevron" size={10} color={accent.ink} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );

  type Slot<T> = { key: string; item: T | null };
  const withAdd = <T extends { id: string }>(items: T[]): Slot<T>[] => [
    ...items.map((item) => ({ key: item.id, item })),
    { key: 'add', item: null },
  ];
  const shortcuts = (
    <View style={split ? { paddingTop: nested ? 4 : 14 } : undefined}>
      {failure ? (
        <View style={{ marginTop: 12 }}>
          <Notice
            tone="danger"
            title={unpin.error ? 'Couldn’t unpin' : 'Couldn’t load your pins'}
            detail={errorText(failure)}
            action={{ label: 'Try again', onPress: pull.onRefresh }}
          />
        </View>
      ) : null}
      {pending && !failure ? <Busy label="Gathering your pins" /> : null}
      {pinned.data ? (
        <>
          <SectionLabel>Apps</SectionLabel>
          <TileGrid
            items={withAdd(pins)}
            keyOf={(slot) => slot.key}
            minTile={tile.minTile}
            gap={tile.gap}
            render={({ item: pin }, tileWidth) => {
              if (!pin)
                return (
                  <View style={{ width: tileWidth, paddingBottom: 12 }}>
                    <ShortcutTile
                      muted
                      width={tileWidth}
                      label="Add"
                      accessibilityLabel="Pin an App to the home screen"
                      onPress={() =>
                        router.push({
                          pathname: '/pin',
                          params: { kind: 'apps' },
                        })
                      }
                    >
                      <AddTile size={TILE} />
                    </ShortcutTile>
                  </View>
                );
              const app = appById.get(pin.appId);
              return (
                <View style={{ width: tileWidth, paddingBottom: 12 }}>
                  <ShortcutTile
                    width={tileWidth}
                    label={pin.label}
                    accessibilityLabel={[
                      pin.label,
                      app && app.name !== pin.label ? app.name : null,
                      pin.entryHash ? `opens at ${pin.entryHash}` : null,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    accessibilityHint="Touch and hold to unpin"
                    onLongPress={() => askUnpin(pin.label, { pinId: pin.id })}
                    onPress={() =>
                      router.push({
                        pathname: '/apps/[id]',
                        params: {
                          id: pin.appId,
                          slug: pin.appSlug,
                          entryHash: pin.entryHash,
                          label: pin.label,
                        },
                      })
                    }
                  >
                    <AppTile
                      name={app?.name ?? pin.label}
                      seed={pin.appId}
                      iconPath={app?.iconPath}
                      size={TILE}
                      lifted
                    />
                  </ShortcutTile>
                </View>
              );
            }}
          />
          <SectionLabel>Workflows</SectionLabel>
          <TileGrid
            items={withAdd(pinnedWorkflows)}
            keyOf={(slot) => slot.key}
            minTile={tile.minTile}
            gap={tile.gap}
            render={({ item }, tileWidth) => (
              <View style={{ width: tileWidth, paddingBottom: 12 }}>
                {item ? (
                  <ShortcutTile
                    width={tileWidth}
                    label={item.name}
                    accessibilityLabel={`${item.name}, workflow`}
                    accessibilityHint="Touch and hold to unpin"
                    onLongPress={() =>
                      askUnpin(item.name, { workflowId: item.id })
                    }
                    onPress={() =>
                      router.push({
                        pathname: '/workflows/[id]',
                        params: { id: item.id },
                      })
                    }
                  >
                    <AppTile
                      name={item.name}
                      seed={item.id}
                      size={TILE}
                      workflow
                      lifted
                    />
                  </ShortcutTile>
                ) : (
                  <ShortcutTile
                    muted
                    width={tileWidth}
                    label="Add"
                    accessibilityLabel="Pin a Workflow to the home screen"
                    onPress={() =>
                      router.push({
                        pathname: '/pin',
                        params: { kind: 'workflows' },
                      })
                    }
                  >
                    <AddTile size={TILE} workflow />
                  </ShortcutTile>
                )}
              </View>
            )}
          />
        </>
      ) : null}
    </View>
  );

  return (
    <PageRoot nested={nested}>
      <ScrollView
        {...pageScrollProps}
        style={{ flex: 1 }}
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: GUTTER }}
        refreshControl={
          <RefreshControl
            refreshing={pull.refreshing}
            onRefresh={pull.onRefresh}
            tintColor={accent.fill}
          />
        }
      >
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
            {widgets}
          </View>
          <View style={split ? { width: split.trailing } : undefined}>
            {shortcuts}
          </View>
        </FoldContainer>
      </ScrollView>
    </PageRoot>
  );
}
