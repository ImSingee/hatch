import { Box, Button, Stack, Text, ThemeIcon } from '@mantine/core';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import {
  Link,
  Navigate,
  createFileRoute,
  isNotFound,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconAlertTriangle,
  IconRocket,
  IconServerBolt,
  IconSettings,
} from '@tabler/icons-react';
import { useEffectEvent, useLayoutEffect, useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { getAppViewState } from '~components/apps/app-view-policy';
import { AppWindowToolbar } from '~components/apps/app-window-toolbar';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import {
  useAppSessionStore,
  useAppSessions,
} from '~components/desk/app-sessions';
import { DeskWindow } from '~components/desk/window';
import { useErrorText, useI18n } from '~i18n';
import { appViewQueryOptions } from '~queries/apps';
import { type AppDetail, getAppDeploymentRevision } from '~server/apps';
import classes from './app-view.module.css';

export const Route = createFileRoute('/_app/app/$appSlug/')({
  loader: ({ context: { queryClient }, params }) =>
    queryClient.fetchQuery({
      ...appViewQueryOptions(params.appSlug),
      staleTime: 0,
    }),
  component: AppView,
});

const readDeploymentRevision = (appId: string) =>
  getAppDeploymentRevision({ data: appId });

// The still percent-encoded fragment of an href, without '#'. The App's route
// travels between the host URL and the surface in this form only.
function rawFragment(href: string) {
  const index = href.indexOf('#');
  return index < 0 ? '' : href.slice(index + 1);
}

/**
 * The App's page. A runnable App is shown by the desk's session manager
 * (`RunningApps`), which keeps it running while other windows are in front;
 * this route only opens or focuses it for the URL. Everything else (not
 * deployed, backend only, an unsupported deployment) is a window of its own.
 */
function AppView() {
  const { appSlug } = Route.useParams();
  const { data: app } = useSuspenseQuery(appViewQueryOptions(appSlug));
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const { canOpen, hasLiveDeployment, isCompatibilityBlocked } =
    getAppViewState({
      status: app.status,
      deploymentRevision: app.deploymentRevision,
      hasFrontend,
      runtimeSupported: app.compatibility?.isSupported ?? false,
    });

  // A running copy is brought forward as it is, whatever the live
  // deployment: a deployment that cannot run here applies on its reload.
  // This App's own session: by id where known, else (a session restored
  // before its details were read) by slug.
  const running = useAppSessions().sessions.some((session) =>
    session.appId ? session.appId === app.id : session.slug === appSlug,
  );
  if (running) return <OpenApp app={app} />;

  // An App without a frontend whose live deployment declares tasks is used
  // through its Tasks pages, so open them instead of a placeholder.
  if (
    !hasFrontend &&
    hasLiveDeployment &&
    !isCompatibilityBlocked &&
    app.capabilities?.tasks
  ) {
    return <Navigate to="/app/$appSlug/tasks" params={{ appSlug }} replace />;
  }

  return canOpen ? <OpenApp app={app} /> : <AppPlaceholder app={app} />;
}

/** Shows a runnable App in front, starting it or focusing it. */
function OpenApp({ app }: { app: AppDetail }) {
  const store = useAppSessionStore();
  const router = useRouter();
  const slug = app.slug;
  // The location the view is rendered for: its raw fragment (e.g. '/settings';
  // '' = root) and its history entry key, which changes on every navigation
  // even when the fragment stays the same. While a navigation to another page
  // is still loading, these keep describing this one.
  const hostFragment = useRouterState({
    select: (s) => rawFragment((s.resolvedLocation ?? s.location).href),
  });
  const hostEntryKey = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).state.__TSR_key,
  });
  const focus = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).state.appFocus === true,
  });
  const liveRevision = useEffectEvent(() => app.deploymentRevision);

  // Each host navigation to the App: start it, bring it forward, or move it
  // to the URL's route. It runs per history entry rather than per hash value,
  // so selecting the pin of the App in front still returns it to the pin's
  // page when the host hash had not caught up with the App's own navigation
  // yet. The App replaces rather than pushes, which keeps the host entry the
  // only new history entry, and skips routes it is already on, so this
  // converges with its route mirror (no ping-pong).
  useLayoutEffect(() => {
    const resolved = router.state.resolvedLocation ?? router.state.location;
    // A newer navigation is still loading; its resolution re-runs this.
    if (router.latestLocation.href !== resolved.href) return;
    const route = store.show(slug, {
      route: hostFragment,
      focus,
      appId: app.id,
      revision: liveRevision(),
    });
    if (route === null) return;
    // The App opened where it was left: put that route in the URL.
    void router.navigate({
      to: '/app/$appSlug',
      params: { appSlug: slug },
      hash: route,
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  }, [hostEntryKey, hostFragment, focus, router, store, slug, app.id]);

  // A layout cleanup, so the App never paints in front next to the page
  // that replaces it.
  useLayoutEffect(() => () => store.leaveFront(slug), [store, slug]);

  return null;
}

/** An App that cannot run here, with what to do about it. */
function AppPlaceholder({ app }: { app: AppDetail }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [reloading, setReloading] = useState(false);
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const { hasLiveDeployment, isCompatibilityBlocked } = getAppViewState({
    status: app.status,
    deploymentRevision: app.deploymentRevision,
    hasFrontend,
    runtimeSupported: app.compatibility?.isSupported ?? false,
  });
  const platformUpdateRequired = Boolean(
    isCompatibilityBlocked &&
    app.compatibility &&
    app.compatibility.version > app.compatibility.latestVersion,
  );
  const { updateAvailable } = useAppDeploymentUpdate({
    appId: app.id,
    deploymentRevision: app.deploymentRevision,
    revisionReader: readDeploymentRevision,
  });

  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await queryClient.fetchQuery({
        ...appViewQueryOptions(app.slug),
        staleTime: 0,
      });
    } catch (error) {
      if (isNotFound(error)) {
        // The app was deleted or renamed; let the loader render not-found.
        await router.invalidate();
        return;
      }
      toast.error(errorText(error, 'appDetail.reloadFailed'));
    } finally {
      setReloading(false);
    }
  };

  return (
    <DeskWindow
      fill
      title={app.name}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      toolbar={
        <AppWindowToolbar
          slug={app.slug}
          canOpen={false}
          updateAvailable={updateAvailable}
          reloading={reloading}
          onReload={reload}
        />
      }
    >
      <Box className={classes.empty}>
        <Stack align="center" gap="xs" maw={440} px="md">
          <ThemeIcon
            size={52}
            radius="xl"
            variant="light"
            color={
              isCompatibilityBlocked
                ? 'red'
                : hasLiveDeployment
                  ? 'gray'
                  : 'primary'
            }
          >
            {isCompatibilityBlocked ? (
              <IconAlertTriangle size={26} stroke={1.5} />
            ) : hasLiveDeployment ? (
              <IconServerBolt size={26} stroke={1.5} />
            ) : (
              <IconRocket size={26} stroke={1.5} />
            )}
          </ThemeIcon>
          <Text fw={700} mt="xs">
            {isCompatibilityBlocked
              ? platformUpdateRequired
                ? t('compatibility.platformUpdate.title')
                : t('compatibility.appUpdate.title')
              : hasLiveDeployment
                ? t('appDetail.backendOnly.title')
                : t('appDetail.notDeployed.title')}
          </Text>
          <Text size="sm" c="dimmed" ta="center">
            {isCompatibilityBlocked
              ? platformUpdateRequired
                ? t('appDetail.platformUpdate.body')
                : t('appDetail.appUpdate.body')
              : hasLiveDeployment
                ? t('appDetail.backendOnly.body')
                : t('appDetail.notDeployed.body')}
          </Text>
          <Button
            variant="default"
            mt="sm"
            leftSection={
              isCompatibilityBlocked && !platformUpdateRequired ? (
                <IconRocket size={16} stroke={1.7} />
              ) : (
                <IconSettings size={16} stroke={1.7} />
              )
            }
            renderRoot={(props) =>
              isCompatibilityBlocked && !platformUpdateRequired ? (
                <Link to="/agent" {...props} />
              ) : (
                <Link
                  to="/app/$appSlug/manage"
                  params={{ appSlug: app.slug }}
                  {...props}
                />
              )
            }
          >
            {isCompatibilityBlocked && !platformUpdateRequired
              ? t('appDetail.openAgent')
              : t('deployment.manageApp')}
          </Button>
        </Stack>
      </Box>
    </DeskWindow>
  );
}
