import {
  ActionIcon,
  Box,
  Button,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  isNotFound,
  useRouter,
  useRouterState,
} from '@tanstack/react-router';
import {
  IconAlertTriangle,
  IconExternalLink,
  IconRefresh,
  IconRocket,
  IconServerBolt,
  IconSettings,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { getAppViewState } from '~components/apps/app-view-policy';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import {
  AppSurface,
  type AppSurfaceHandle,
  canonicalRoute,
} from '~components/desk/app-surface';
import { appSurfaceSource } from '~components/desk/app-surface-source';
import { DeskWindow } from '~components/desk/window';
import { appViewQueryOptions } from '~queries/apps';
import { getAppDeploymentRevision } from '~server/apps';
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

function AppView() {
  const { appSlug } = Route.useParams();
  const appQueryOptions = appViewQueryOptions(appSlug);
  const { data: app } = useSuspenseQuery(appQueryOptions);
  const surface = useRef<AppSurfaceHandle>(null);
  const [reloading, setReloading] = useState(false);
  const hasFrontend = Boolean(app.capabilities?.frontend);
  const { canOpen, hasLiveDeployment, isCompatibilityBlocked } =
    getAppViewState({
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
  const router = useRouter();
  // The location the view is rendered for: its raw fragment (e.g. '/settings';
  // '' = root) and its history entry key, which changes on every navigation
  // even when the fragment stays the same. While a navigation to another app
  // is still loading, these keep describing the outgoing app.
  const hostFragment = useRouterState({
    select: (s) => rawFragment((s.resolvedLocation ?? s.location).href),
  });
  const hostEntryKey = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).state.__TSR_key,
  });
  // The route a (re)loading App opens at: the newest host location, so a deep
  // link reaches the App before it reports its own route back.
  const seedRoute = useRouterState({
    select: (s) => rawFragment(s.location.href),
  });

  // Mirror the App's route out to the host URL, so the host URL stays
  // shareable and refreshable: its hash deep-links into the App.
  const mirrorRoute = (fragment: string) => {
    const { latestLocation, state } = router;
    const resolved = state.resolvedLocation ?? state.location;
    // A navigation away from this app is in flight; don't override it.
    if (latestLocation.pathname !== resolved.pathname) return;
    if (
      canonicalRoute(fragment) ===
      canonicalRoute(rawFragment(latestLocation.href))
    )
      return;
    void router.navigate({
      to: '/app/$appSlug',
      params: { appSlug },
      // The router writes `hash` into the URL verbatim, so pass it encoded.
      hash: fragment,
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  };

  // The browser tab shows whichever page the user is on inside the App, and
  // gets the platform's title back when the App closes.
  useEffect(() => {
    const hostTitle = document.title;
    return () => {
      document.title = hostTitle;
    };
  }, [appSlug]);
  const mirrorTitle = (title: string | null) => {
    if (title && title !== document.title) document.title = title;
  };

  // Push each host navigation into the already-loaded App. The surface seeds
  // fresh loads itself (and app switches mount a new surface); this covers
  // navigations within the current app, such as selecting its dock pin or
  // going back, where the App stays loaded. It runs per history entry rather
  // than per hash value, so selecting a pin still resets the App when the host
  // hash had not caught up with the App's own navigation yet. The surface
  // replaces rather than pushes, which keeps the host entry the only new
  // history entry, and skips routes the App is already on, so this converges
  // with the mirror above (no ping-pong).
  useEffect(() => {
    if (!canOpen) return;
    const resolved = router.state.resolvedLocation ?? router.state.location;
    // A newer navigation is still loading; its resolution re-runs this.
    if (router.latestLocation.href !== resolved.href) return;
    surface.current?.navigate(hostFragment);
  }, [hostEntryKey, hostFragment, canOpen, router]);

  const queryClient = useQueryClient();
  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      // Refetch through the query rather than invalidating the route: a failed
      // route loader replaces the whole view with an error state, while a
      // failed query refetch keeps the cached snapshot and its running App.
      await queryClient.fetchQuery({ ...appQueryOptions, staleTime: 0 });
      surface.current?.reload();
    } catch (error) {
      if (isNotFound(error)) {
        // The app was deleted or renamed; let the loader render not-found.
        await router.invalidate();
        return;
      }
      toast.error(
        error instanceof Error ? error.message : 'Could not reload the app.',
      );
    } finally {
      setReloading(false);
    }
  };

  const reloadLabel = updateAvailable
    ? 'Update available — reload app'
    : 'Reload app';
  // Clicking the pill hands off to the plain reload icon, which carries the
  // loading state; the pill only returns if the reload fails.
  const showUpdatePill = updateAvailable && !reloading;

  return (
    <DeskWindow
      fill
      title={app.name}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      toolbar={
        <>
          {canOpen || updateAvailable ? (
            <>
              {showUpdatePill ? (
                <Box component="output" className={classes.update}>
                  <Tooltip label="Reload to apply the new version" withArrow>
                    <Button
                      size="compact-sm"
                      variant="light"
                      color="primary"
                      // The light variant's default shade-6 text is ~3.3:1 on
                      // its tint; shade 8 keeps small text above WCAG AA.
                      c="primary.8"
                      radius="xl"
                      fw={600}
                      className={classes.updateButton}
                      aria-label={reloadLabel}
                      onClick={reload}
                      leftSection={
                        <IconRefresh
                          className={classes.updateIcon}
                          size={15}
                          stroke={2}
                          aria-hidden
                        />
                      }
                    >
                      Update available
                    </Button>
                  </Tooltip>
                </Box>
              ) : (
                <Tooltip label={reloadLabel} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={reloadLabel}
                    loading={reloading}
                    onClick={reload}
                  >
                    <IconRefresh size={18} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              )}
              {canOpen ? (
                <Tooltip label="Open in new tab" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    component="a"
                    href={appSurfaceSource(app.slug)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in new tab"
                  >
                    <IconExternalLink size={18} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
            </>
          ) : null}
          <Tooltip label="Manage" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Manage"
              renderRoot={(props) => (
                <Link
                  to="/app/$appSlug/manage"
                  params={{ appSlug: app.slug }}
                  {...props}
                />
              )}
            >
              <IconSettings size={18} stroke={1.7} />
            </ActionIcon>
          </Tooltip>
        </>
      }
    >
      {canOpen ? (
        <AppSurface
          // One surface per App: switching Apps mounts a fresh one.
          key={app.slug}
          ref={surface}
          app={app}
          route={seedRoute}
          onRouteChange={mirrorRoute}
          onTitleChange={mirrorTitle}
        />
      ) : (
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
                  ? 'Platform update required'
                  : 'App update required'
                : hasLiveDeployment
                  ? 'Backend-only app'
                  : 'Not deployed yet'}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              {isCompatibilityBlocked
                ? platformUpdateRequired
                  ? 'This App deployment is newer than the current platform. Update the platform before running it.'
                  : 'This App cannot run on the current platform. Use Agent to update and redeploy it.'
                : hasLiveDeployment
                  ? 'This app has no frontend — it runs a backend (cron or webhook). Open Manage to inspect its capabilities.'
                  : 'Deploy this app to use it here. You can build and deploy it from the Manage page.'}
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
                ? 'Open Agent'
                : 'Manage app'}
            </Button>
          </Stack>
        </Box>
      )}
    </DeskWindow>
  );
}
