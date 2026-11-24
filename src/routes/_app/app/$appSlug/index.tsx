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
  Navigate,
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
import { useErrorText, useI18n } from '~i18n';
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
  const { t } = useI18n();
  const errorText = useErrorText();
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

  // The browser tab shows whichever page the user is on inside the App, or
  // the App's name until that page reports a title. Kept per App, so a switch
  // to another App does not show the previous one's page.
  const [embeddedTitle, setEmbeddedTitle] = useState<{
    appSlug: string;
    title: string | null;
  } | null>(null);
  // The surface reports on every change to the App's head, often with the
  // same title, so keep the current state when nothing changed.
  const mirrorTitle = (title: string | null) =>
    setEmbeddedTitle((current) =>
      current?.appSlug === appSlug && current.title === title
        ? current
        : { appSlug, title },
    );
  const pageTitle =
    (embeddedTitle?.appSlug === appSlug && embeddedTitle.title) || app.name;

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
      toast.error(errorText(error, 'appDetail.reloadFailed'));
    } finally {
      setReloading(false);
    }
  };

  const reloadLabel = updateAvailable
    ? t('appDetail.updateReload')
    : t('appDetail.reload');
  // Clicking the pill hands off to the plain reload icon, which carries the
  // loading state; the pill only returns if the reload fails.
  const showUpdatePill = updateAvailable && !reloading;

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

  return (
    <DeskWindow
      fill
      title={app.name}
      documentTitle={pageTitle}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      toolbar={
        <>
          {canOpen || updateAvailable ? (
            <>
              {showUpdatePill ? (
                <Box component="output" className={classes.update}>
                  <Tooltip label={t('appDetail.reloadToApply')} withArrow>
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
                      {t('appDetail.updateAvailable')}
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
                <Tooltip label={t('appDetail.openInNewTab')} withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    component="a"
                    href={appSurfaceSource(app.slug)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t('appDetail.openInNewTab')}
                  >
                    <IconExternalLink size={18} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              ) : null}
            </>
          ) : null}
          <Tooltip label={t('common.manage')} withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={t('common.manage')}
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
      )}
    </DeskWindow>
  );
}
