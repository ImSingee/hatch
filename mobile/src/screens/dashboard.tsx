import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REFRESH_PRESETS, formatInterval } from '@hatch/platform-api';
import { useCallback, useState } from 'react';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { dashboardDestination, type BrowserDestination } from '../core';
import { useSession } from '../state/session';
import { openSurfaceLink } from '../state/deep-links';
import { useAppActive } from '../state/use-app-active';
import { useDashboardAutoRefresh } from '../state/use-dashboard-auto-refresh';
import { useLifetimeSignal } from '../state/use-lifetime-signal';
import { useSurfaceHandoff } from '../state/use-surface-handoff';
import { RefreshMenu } from '../ui/native-controls';
import { Busy, EmptyState, Notice, errorText } from '../ui/primitives';
import { useAccent } from '../ui/accent';
import { Screen } from '../ui/screen';
import { SecureSurface } from '../ui/secure-surface';
import { palette as c, pill, radii, shadows } from '../ui/theme';

/**
 * The dashboards of the instance and the one on show. Widgets are web
 * content: a dashboard is one web canvas, shown in a sheet on the home screen
 * and at full height on the Widgets page.
 */
export function useDashboards(focused: boolean) {
  const { api, origin, epoch } = useSession();
  const queryClient = useQueryClient();
  const lifetime = useLifetimeSignal();
  const [ready, setReady] = useState(false);
  // Each bump asks the loaded canvas to refresh its widgets once.
  const [refreshRevision, setRefreshRevision] = useState(0);
  // A link names a dashboard; each delivery (a new `at`) selects it again.
  const linked = useLocalSearchParams<{ dashboard?: string; at?: string }>();
  const delivery = linked.dashboard ? `${linked.dashboard} ${linked.at}` : null;
  const [selection, setSelection] = useState(linked.dashboard ?? null);
  const [delivered, setDelivered] = useState(delivery);
  if (delivery !== delivered) {
    setDelivered(delivery);
    if (linked.dashboard) setSelection(linked.dashboard);
  }
  const [attempt, setAttempt] = useState(0);
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const dashboards = workspace.data?.dashboards ?? [];
  const missing =
    Boolean(workspace.data && selection) &&
    selection === linked.dashboard &&
    !dashboards.some((d) => d.id === selection);
  const current =
    dashboards.find((d) => d.id === selection) ??
    dashboards.find((d) => d.pinned) ??
    dashboards[0];
  let destination: BrowserDestination | null = null;
  let invalid: unknown = null;
  try {
    destination = current ? dashboardDestination(current.id) : null;
  } catch (error) {
    invalid = error;
  }
  // Recovery re-reads the list and establishes a fresh browser session.
  const retry = () => {
    void workspace.refetch();
    setAttempt((v) => v + 1);
  };
  const refreshWidgets = useCallback(
    () => setRefreshRevision((value) => value + 1),
    [],
  );
  // A manual refresh also re-reads names and intervals saved on the web.
  const refresh = () => {
    void workspace.refetch();
    refreshWidgets();
  };
  const seconds = current?.autoRefreshSeconds ?? 0;
  const active = useAppActive();
  useDashboardAutoRefresh({
    enabled: focused && active && ready,
    dashboardId: current?.id,
    seconds,
    refresh: refreshWidgets,
  });
  const saveInterval = useMutation({
    mutationFn: (input: { id: string; seconds: number }) =>
      api!.setDashboardAutoRefresh(input.id, input.seconds, lifetime()),
    onSuccess: (result, input) => {
      if (lifetime().aborted) return;
      queryClient.setQueryData<typeof workspace.data>(
        [origin, 'workspace'],
        (data) =>
          data
            ? {
                ...data,
                dashboards: data.dashboards.map((dashboard) =>
                  dashboard.id === input.id
                    ? { ...dashboard, autoRefreshSeconds: result.seconds }
                    : dashboard,
                ),
              }
            : data,
      );
    },
  });
  return {
    origin,
    epoch,
    focused,
    workspace,
    dashboards,
    current,
    missing,
    destination,
    invalid,
    attempt,
    retry,
    refresh,
    refreshWidgets,
    refreshRevision,
    seconds,
    saveInterval,
    ready,
    setReady,
    select: setSelection,
  };
}

export type Dashboards = ReturnType<typeof useDashboards>;

/** Refresh now and auto refresh for the dashboard on show. */
export function DashboardRefresh({ board }: { board: Dashboards }) {
  const { current, seconds, saveInterval } = board;
  const intervals = REFRESH_PRESETS.some((preset) => preset.seconds === seconds)
    ? REFRESH_PRESETS
    : [...REFRESH_PRESETS, { label: formatInterval(seconds), seconds }];
  return (
    <RefreshMenu
      label="Refresh widgets"
      // With no dashboards there is no canvas to wait for; a refresh can
      // still find one created on the web.
      disabled={
        !board.ready && !(board.workspace.data && !board.dashboards.length)
      }
      onRefresh={board.refresh}
      interval={String(current ? seconds : 0)}
      intervalLabel={seconds ? formatInterval(seconds) : undefined}
      intervalDisabled={!current || saveInterval.isPending}
      options={intervals.map((preset) => ({
        value: String(preset.seconds),
        label: preset.seconds ? 'Every ' + preset.label : 'Off',
      }))}
      onInterval={(value) => {
        if (current)
          saveInterval.mutate({ id: current.id, seconds: Number(value) });
      }}
    />
  );
}

/**
 * Page dots, one per dashboard: the one on show is a short accent bar. Each
 * dot is a tab named after its dashboard.
 */
export function DashboardPager({ board }: { board: Dashboards }) {
  const accent = useAccent();
  if (board.dashboards.length < 2) return null;
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel="Dashboards"
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      {board.dashboards.map((dashboard) => {
        const selected = dashboard.id === board.current?.id;
        return (
          <Pressable
            key={dashboard.id}
            accessibilityRole="tab"
            accessibilityLabel={dashboard.name}
            accessibilityState={{ selected }}
            onPress={() => board.select(dashboard.id)}
            style={{
              minWidth: selected ? 30 : 20,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                width: selected ? 18 : 7,
                height: 7,
                borderRadius: pill,
                backgroundColor: selected ? accent.fill : c.idle,
              }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** Problems with the dashboard on show, above its sheet. */
export function DashboardNotices({ board }: { board: Dashboards }) {
  return (
    <>
      {board.missing ? (
        <Notice
          tone="danger"
          title="Couldn’t find that dashboard"
          detail="It may have been deleted. Showing another dashboard."
        />
      ) : null}
      {board.saveInterval.error ? (
        <Notice
          tone="danger"
          title="Couldn’t save refresh interval"
          detail={errorText(board.saveInterval.error)}
        />
      ) : null}
    </>
  );
}

/** The white sheet a dashboard's widgets are shown on. */
export function WidgetSheet({
  board,
  style,
}: {
  board: Dashboards;
  style?: StyleProp<ViewStyle>;
}) {
  const { workspace, destination, current, invalid, retry } = board;
  const failed = Boolean((workspace.error && !workspace.data) || invalid);
  // The web canvas draws its widgets as sheets on the ground itself, so it
  // gets no sheet of its own; the native states in its place do.
  const canvas = !failed && Boolean(destination && current);
  return (
    <View
      style={[
        { borderRadius: radii.xl },
        !canvas && { backgroundColor: c.card, boxShadow: shadows.card },
        style,
      ]}
    >
      <View style={{ flex: 1, borderRadius: radii.xl, overflow: 'hidden' }}>
        {failed ? (
          <View style={{ padding: 12 }}>
            <Notice
              tone="danger"
              title="Couldn’t load your widgets"
              detail={errorText(workspace.error ?? invalid)}
              action={{ label: 'Try again', onPress: retry }}
            />
          </View>
        ) : destination && current ? (
          // One surface per lifetime: switching dashboards navigates the same
          // WebView, and a surface that comes back signs in afresh.
          <DashboardSurface
            key={`${board.epoch}-${board.attempt}`}
            origin={board.origin!}
            focused={board.focused}
            destination={destination}
            dashboardRefresh={{
              id: current.id,
              revision: board.refreshRevision,
            }}
            retry={retry}
            onReady={board.setReady}
          />
        ) : workspace.isPending ? (
          <Busy label="Loading widgets" />
        ) : (
          <View style={{ paddingHorizontal: 20 }}>
            <EmptyState
              glyph="dashboard"
              title="No widgets yet"
              detail="Create a dashboard in Hatch on the web. Its widgets will appear here, live."
            />
          </View>
        )}
      </View>
    </View>
  );
}

/** Every widget of a dashboard, at full height. */
export function DashboardScreen({ nested = false }: { nested?: boolean }) {
  const insets = useSafeAreaInsets();
  // Native tabs mount hidden screens: the surface's sign-in and the refresh
  // timer wait until this one is on screen.
  const board = useDashboards(useIsFocused());
  return (
    <Screen
      eyebrow={board.current?.name}
      title="Widgets"
      nested={nested}
      actions={<DashboardRefresh board={board} />}
    >
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        <DashboardNotices board={board} />
      </View>
      {board.dashboards.length > 1 ? (
        <View style={{ alignItems: 'center' }}>
          <DashboardPager board={board} />
        </View>
      ) : null}
      <WidgetSheet
        board={board}
        style={{
          flex: 1,
          marginHorizontal: 12,
          marginBottom: insets.bottom + 8,
        }}
      />
    </Screen>
  );
}

/** Owns one web surface and the one-use ticket it signs in with. */
function DashboardSurface({
  origin,
  focused,
  destination,
  dashboardRefresh,
  retry,
  onReady,
}: {
  origin: string;
  focused: boolean;
  destination: BrowserDestination;
  dashboardRefresh: { id: string; revision: number };
  retry: () => void;
  onReady: (ready: boolean) => void;
}) {
  const { api } = useSession();
  // Native tabs mount hidden screens. Tickets live for a minute, so a hidden
  // dashboard waits until it is on screen before claiming one.
  const handoff = useSurfaceHandoff({ api, origin, focused });
  if (handoff.error)
    return (
      <View style={{ padding: 12 }}>
        <Notice
          tone="danger"
          title="Couldn’t load your dashboard"
          detail={errorText(handoff.error)}
          action={{ label: 'Try again', onPress: retry }}
        />
      </View>
    );
  if (!handoff.data) return <Busy label="Loading widgets" />;
  return (
    <SecureSurface
      origin={origin}
      handoff={handoff.data}
      destination={destination}
      retry={retry}
      dashboardRefresh={dashboardRefresh}
      onReady={onReady}
      onRoute={openSurfaceLink}
    />
  );
}
