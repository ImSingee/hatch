import { routeErrorMessage } from '~components/system/route-error';
import { Button, Skeleton, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  createFileRoute,
  Link,
  redirect,
  useBlocker,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/react-router';
import { IconAlertTriangle, IconPlus, IconRefresh } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { AddWidgetPanel } from '~components/dashboard/add-widget-panel';
import { DashboardGrid } from '~components/dashboard/dashboard-grid';
import { DashboardGridStage } from '~components/dashboard/dashboard-grid-stage';
import { DeskToolbar } from '~components/dashboard/desk-toolbar';
import { EditorHeading } from '~components/dashboard/editor-heading';
import {
  DashboardEmptyState,
  type DashboardEmptyStateKind,
} from '~components/dashboard/empty-state';
import { useDashboardDraft } from '~components/dashboard/use-dashboard-draft';
import { useLiveDashboard } from '~components/dashboard/use-live-dashboard';
import { WidgetPager } from '~components/dashboard/widget-pager';
import { DeskHome } from '~components/desk/desk-home';
import { QuickAgentChat } from '~components/desk/quick-agent-chat';
import { TodayPanel } from '~components/desk/today-panel';
import { appsQueryOptions } from '~queries/apps';
import {
  availableWidgetsQueryOptions,
  dashboardQueryOptions,
  dashboardsQueryOptions,
} from '~queries/dashboards';
import { setDashboardAutoRefresh } from '~server/dashboards';
import {
  dashboardBreakpointForWidth,
  type DashboardBreakpoint,
} from '~/lib/dashboard-layout';
import classes from './dashboard.module.css';

export const Route = createFileRoute('/_app/dashboard/$dashboardId')({
  loader: async ({ context, params }) => {
    const dashboards = await context.queryClient.ensureQueryData(
      dashboardsQueryOptions,
    );
    if (!dashboards.some((dashboard) => dashboard.id === params.dashboardId)) {
      const first = dashboards[0]?.id;
      if (first) {
        throw redirect({
          to: '/dashboard/$dashboardId',
          params: { dashboardId: first },
        });
      }
    }
    await Promise.all([
      context.queryClient.ensureQueryData(appsQueryOptions),
      context.queryClient.ensureQueryData(availableWidgetsQueryOptions),
      context.queryClient.ensureQueryData(
        dashboardQueryOptions(params.dashboardId),
      ),
    ]);
  },
  pendingComponent: DeskSkeleton,
  errorComponent: DeskError,
  component: DashboardPage,
});

function DashboardPage() {
  const { dashboardId } = Route.useParams();
  return <DashboardWorkspace key={dashboardId} dashboardId={dashboardId} />;
}

/** "Good afternoon, Sam" from the time of day and the first name. */
function useGreeting(): string {
  const { data } = authClient.useSession();
  const hour = dayjs().hour();
  const part =
    hour < 5
      ? 'evening'
      : hour < 12
        ? 'morning'
        : hour < 18
          ? 'afternoon'
          : 'evening';
  const name = data?.user.name?.trim().split(/\s+/)[0];
  return name ? `Good ${part}, ${name}` : `Good ${part}`;
}

function HeadingActions({ appCount }: { appCount: number }) {
  return (
    <>
      <Button
        component={Link}
        to="/agent"
        leftSection={<IconPlus size={15} stroke={2.2} />}
      >
        New app
      </Button>
      <Button component={Link} to="/apps" variant="default">
        All apps ({appCount})
      </Button>
    </>
  );
}

function DashboardWorkspace({ dashboardId }: { dashboardId: string }) {
  const queryClient = useQueryClient();
  const greeting = useGreeting();
  const { data: dashboards } = useSuspenseQuery(dashboardsQueryOptions);
  const { data: dashboardData } = useSuspenseQuery(
    dashboardQueryOptions(dashboardId),
  );
  const { data: available } = useSuspenseQuery(availableWidgetsQueryOptions);
  const { data: apps } = useSuspenseQuery(appsQueryOptions);
  const current = dashboards.find((dashboard) => dashboard.id === dashboardId);
  const [editing, setEditing] = useState(false);
  const [previewBreakpoint, setPreviewBreakpoint] =
    useState<DashboardBreakpoint>('desktop');
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [showAllWidgets, setShowAllWidgets] = useState(false);
  const phone = useMediaQuery('(max-width: 35em)');
  const editor = useDashboardDraft({
    dashboardId,
    initialData: dashboardData,
  });
  useLiveDashboard(dashboardId, editing);
  useBlocker({
    shouldBlockFn: () =>
      editing &&
      (editor.dirty || editor.locked) &&
      !window.confirm('Dashboard changes are not saved yet. Leave this page?'),
    enableBeforeUnload: editing && (editor.dirty || editor.locked),
  });

  const autoRefreshSeconds = current?.autoRefreshSeconds ?? 0;
  useEffect(() => {
    if (editing || autoRefreshSeconds <= 0) return;
    const id = window.setInterval(
      () => setRefreshSignal((signal) => signal + 1),
      autoRefreshSeconds * 1000,
    );
    return () => window.clearInterval(id);
  }, [autoRefreshSeconds, dashboardId, editing]);

  const setAutoRefresh = useMutation({
    mutationFn: (seconds: number) =>
      setDashboardAutoRefresh({ data: { id: dashboardId, seconds } }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: dashboardsQueryOptions.queryKey,
      }),
  });

  const beginEditing = () => {
    editor.reset(dashboardData);
    // Start on the layout the current width shows, so the preview fits.
    setPreviewBreakpoint(
      dashboardBreakpointForWidth(Math.min(window.innerWidth, 1200) - 40),
    );
    setEditing(true);
  };
  const finish = (saved: boolean) => {
    if (!saved) return;
    setEditing(false);
    toast.success('Dashboard changes saved');
  };
  const cancelEditing = () => {
    if (!editor.cancel()) return;
    setEditing(false);
  };
  const done = async () => {
    if (!editor.dirty) {
      setEditing(false);
      return;
    }
    finish(await editor.save());
  };

  const liveApps = apps.filter((app) => app.status !== 'archived');
  const emptyState: DashboardEmptyStateKind = editing
    ? 'editing'
    : liveApps.length === 0
      ? 'no-apps'
      : available.length === 0
        ? 'no-widgets'
        : 'empty-dashboard';

  const activeData = editing ? editor.draft : dashboardData;
  const widgets =
    activeData.widgets.length === 0 ? (
      <DashboardEmptyState
        state={emptyState}
        onAddWidget={
          emptyState === 'empty-dashboard' ? beginEditing : undefined
        }
      />
    ) : phone && !editing && !showAllWidgets ? (
      <WidgetPager
        items={activeData.widgets}
        layouts={activeData.layouts}
        refreshSignal={refreshSignal}
        onShowAll={() => setShowAllWidgets(true)}
      />
    ) : (
      <DashboardGridStage
        editing={editing}
        previewBreakpoint={previewBreakpoint}
      >
        {(transformScale) => (
          <DashboardGrid
            items={activeData.widgets}
            layouts={activeData.layouts}
            editing={editing}
            previewBreakpoint={editing ? previewBreakpoint : undefined}
            transformScale={transformScale}
            refreshSignal={refreshSignal}
            removeDisabled={editor.locked}
            interactionDisabled={editor.locked}
            onRemove={editor.removeWidget}
            onLayoutCommit={editor.commitLayout}
          />
        )}
      </DashboardGridStage>
    );

  return (
    <DeskHome
      title={greeting}
      description={current?.description?.trim() || undefined}
      editing={editing}
      actions={<HeadingActions appCount={liveApps.length} />}
      toolbar={
        current ? (
          <DeskToolbar
            dashboard={current}
            onEdit={beginEditing}
            onRefresh={() => setRefreshSignal((signal) => signal + 1)}
          />
        ) : null
      }
      editor={
        <EditorHeading
          dashboardName={current?.name ?? 'Dashboard'}
          autoRefreshSeconds={autoRefreshSeconds}
          widgetCount={editor.draft.widgets.length}
          previewBreakpoint={previewBreakpoint}
          onPreviewChange={setPreviewBreakpoint}
          status={editor.status}
          onCheckStatus={() => void editor.checkStatus().then(finish)}
          onDone={() => void done()}
          doneDisabled={editor.locked}
        />
      }
      editorPanel={
        <AddWidgetPanel
          available={available}
          placed={editor.draft.widgets}
          apps={liveApps}
          onAdd={editor.addWidget}
          disabled={editor.locked}
          autoRefreshSeconds={autoRefreshSeconds}
          onAutoRefreshChange={(seconds) => setAutoRefresh.mutate(seconds)}
          onCancel={cancelEditing}
          onDone={() => void done()}
          cancelDisabled={editor.cancelDisabled}
          saving={editor.status.state === 'saving'}
        />
      }
      today={<TodayPanel />}
      companion={<QuickAgentChat />}
    >
      {widgets}
    </DeskHome>
  );
}

/** While the desk loads: its shape, with nothing to read yet. */
function DeskSkeleton() {
  return (
    <div
      className={classes.state}
      aria-busy="true"
      aria-label="Loading the desk"
    >
      <div className={classes.skeletonHeading}>
        <Skeleton height={14} width={150} radius="sm" />
        <Skeleton height={34} width={300} radius="md" />
      </div>
      <div className={classes.skeletonGrid}>
        {[2, 1, 1, 1, 2].map((span, index) => (
          <div
            key={index}
            className={classes.skeletonPanel}
            style={{ gridColumn: `span ${span}` }}
          >
            <Skeleton height={26} width="45%" radius="md" />
            <Skeleton height={44} width="30%" radius="md" />
            <Skeleton height={10} radius="sm" />
            <Skeleton height={10} width="70%" radius="sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The desk could not be read: say so on the desk and offer a retry. */
function DeskError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className={classes.state}>
      <div className={classes.errorPanel} role="alert">
        <span className={classes.errorTile} aria-hidden>
          <IconAlertTriangle size={26} stroke={1.7} />
        </span>
        <h1 className={classes.errorTitle}>The desk didn’t load</h1>
        <Text c="dimmed" ta="center" maw={420}>
          {routeErrorMessage(error)}
        </Text>
        <Button
          type="button"
          leftSection={<IconRefresh size={16} stroke={2} />}
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
