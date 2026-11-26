import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSession } from '../state/session';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { useAccent } from '../ui/accent';
import { FoldContainer, TileGrid, useFoldSplit } from '../ui/columns';
import { Glyph } from '../ui/glyph';
import { Busy, Notice, errorText } from '../ui/primitives';
import { AddTile, AppTile, ShortcutTile, useShortcutGrid } from '../ui/rows';
import {
  Masthead,
  PageRoot,
  SectionLabel,
  pageScrollProps,
} from '../ui/screen';
import { Text, type } from '../ui/text';
import { TileMenu } from '../ui/tile-menu';
import {
  DashboardNotices,
  DashboardPager,
  DashboardRefresh,
  WidgetSheet,
  useDashboards,
} from './dashboard';

const GUTTER = 20;
/** Three 80 px widget rows, their two gaps and the canvas padding. */
const PEEK_HEIGHT = 300;

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
 * over the grid of pinned Apps. With room for two columns the
 * widgets take the leading one and the pins the trailing one, split on the
 * fold.
 */
export function HomeScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const accent = useAccent();
  const focused = useIsFocused();
  const tile = useShortcutGrid();
  const queryClient = useQueryClient();
  const lifetime = useLifetimeSignal();
  const board = useDashboards(focused, { peek: true });
  const { onLayout, onFolds, split } = useFoldSplit({
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
  // The user's pins are the same on every client: a change re-reads them,
  // and the workspace that marks a pinned App on its App page.
  const changed = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: [origin, 'pins'] }),
      queryClient.invalidateQueries({ queryKey: [origin, 'workspace'] }),
    ]);
  const unpin = useMutation({
    mutationFn: (pinId: string) => api!.unpinApp(pinId, lifetime()),
    onSettled: changed,
  });
  // Unpinning is undone by pinning again, so the menu item acts at once.
  const unpinAction = (pinId: string) => ({
    label: 'Unpin from Home',
    glyph: 'pinSlash' as const,
    destructive: true,
    onPress: () => unpin.mutate(pinId),
  });
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
  const sheetHeight = split
    ? Math.max(280, height - 210)
    : // Room for a widget three rows tall, the canvas's common size.
      PEEK_HEIGHT;

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
            action={
              // A failed unpin retries that removal; a failed load re-reads.
              unpin.error && unpin.variables
                ? {
                    label: 'Try again',
                    onPress: () => unpin.mutate(unpin.variables!),
                  }
                : { label: 'Try again', onPress: pull.onRefresh }
            }
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
                      onPress={() => router.push('/pin')}
                    >
                      <AddTile size={tile.tile} />
                    </ShortcutTile>
                  </View>
                );
              const app = appById.get(pin.appId);
              return (
                <View style={{ width: tileWidth, paddingBottom: 12 }}>
                  <TileMenu
                    actions={[
                      {
                        label: 'App details',
                        glyph: 'info',
                        onPress: () =>
                          router.push({
                            pathname: '/manage/[id]',
                            params: { id: pin.appId, slug: pin.appSlug },
                          }),
                      },
                      unpinAction(pin.id),
                    ]}
                  >
                    {(onLongPress) => (
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
                        accessibilityHint="Touch and hold for App details or to unpin"
                        onLongPress={onLongPress}
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
                          size={tile.tile}
                          lifted
                        />
                      </ShortcutTile>
                    )}
                  </TileMenu>
                </View>
              );
            }}
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
