import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isNotFound, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { getAppViewState } from '~components/apps/app-view-policy';
import { AppWindowToolbar } from '~components/apps/app-window-toolbar';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import { useErrorText } from '~i18n';
import { appViewQueryOptions } from '~queries/apps';
import { type AppDetail, getAppDeploymentRevision } from '~server/apps';
import {
  type AppSession,
  useAppSessionStore,
  useAppSessions,
} from './app-sessions';
import {
  AppSurface,
  type AppSurfaceHandle,
  canonicalRoute,
} from './app-surface';
import { DeskWindow, type WindowPlacement } from './window';

const readDeploymentRevision = (appId: string) =>
  getAppDeploymentRevision({ data: appId });

/** The still percent-encoded fragment of an href, without '#'. */
function rawFragment(href: string) {
  const index = href.indexOf('#');
  return index < 0 ? '' : href.slice(index + 1);
}

/** Whether a running App can still run its frontend. */
function canRun(app: AppDetail) {
  return getAppViewState({
    status: app.status,
    deploymentRevision: app.deploymentRevision,
    hasFrontend: Boolean(app.capabilities?.frontend),
    runtimeSupported: app.compatibility?.isSupported ?? false,
  }).canOpen;
}

/** Which running App is on screen beside the window in front, if any. */
export function useVisibleBeside(besideShown: boolean) {
  const { sessions, front, beside } = useAppSessions();
  return besideShown &&
    beside !== null &&
    beside !== front &&
    sessions.some((session) => session.slug === beside)
    ? beside
    : null;
}

/**
 * Every running App's window, kept mounted while it waits on the desk so the
 * App keeps its screen and unsaved input. The windows render in the order
 * the Apps were opened, which never changes, so no frame ever moves in the
 * document; where a window shows (in front, beside it, or not at all) is
 * only its placement. A hidden App gets no data events (see `AppSurface`).
 */
export function RunningApps({ besideShown }: { besideShown: boolean }) {
  const store = useAppSessionStore();
  const { sessions, front } = useAppSessions();
  const beside = useVisibleBeside(besideShown);
  const onScreen = sessions
    .filter((session) => session.slug === front || session.slug === beside)
    .map((session) => session.slug);
  const onScreenKey = onScreen.join('\n');

  useEffect(() => {
    store.setVisible(onScreenKey ? onScreenKey.split('\n') : []);
  }, [store, onScreenKey]);

  return sessions.map((session) => (
    <SessionWindow
      key={session.slug}
      session={session}
      placement={
        session.slug === front
          ? 'front'
          : session.slug === beside
            ? 'beside'
            : 'hidden'
      }
    />
  ));
}

function SessionWindow({
  session,
  placement,
}: {
  session: AppSession;
  placement: WindowPlacement;
}) {
  const store = useAppSessionStore();
  const { slug, revision } = session;
  const { data: app, error } = useQuery(appViewQueryOptions(slug));
  const runnable = app ? canRun(app) : null;

  // The App is gone, or can no longer run here: stop it. In front, the App's
  // page shows why. A failed read of an App that is still there keeps it.
  const gone = isNotFound(error) || (!app && error !== null);
  useEffect(() => {
    if (gone || runnable === false) store.quit(slug);
  }, [gone, runnable, store, slug]);

  const queryClient = useQueryClient();
  useEffect(() => {
    // An App started beside (or restored there) reads its live deployment
    // before it loads: the cached details may predate a redeploy.
    if (revision !== undefined) return;
    let current = true;
    queryClient
      .fetchQuery({ ...appViewQueryOptions(slug), staleTime: 0 })
      .then((fresh) => {
        if (current) store.setRevision(slug, fresh.deploymentRevision);
      })
      .catch(() => {
        // Gone: the query's error stops the App. Otherwise run what is
        // known rather than nothing.
        const cached = queryClient.getQueryData(
          appViewQueryOptions(slug).queryKey,
        );
        if (current && cached)
          store.setRevision(slug, cached.deploymentRevision);
      });
    return () => {
      current = false;
    };
  }, [queryClient, revision, store, slug]);

  if (!app || !runnable || revision === undefined) return null;
  return (
    <RunningAppWindow
      app={app}
      session={session}
      revision={revision}
      placement={placement}
    />
  );
}

function RunningAppWindow({
  app,
  session,
  revision,
  placement,
}: {
  app: AppDetail;
  session: AppSession;
  revision: string | null;
  placement: WindowPlacement;
}) {
  const errorText = useErrorText();
  const store = useAppSessionStore();
  const router = useRouter();
  const queryClient = useQueryClient();
  const surface = useRef<AppSurfaceHandle>(null);
  const [reloading, setReloading] = useState(false);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const { slug } = session;
  const { pendingRevision, updateAvailable } = useAppDeploymentUpdate({
    appId: app.id,
    deploymentRevision: revision,
    revisionReader: readDeploymentRevision,
  });

  useEffect(
    () =>
      store.register(slug, {
        navigate: (route) => surface.current?.navigate(route),
      }),
    [store, slug],
  );

  // The App moved by itself. In front, mirror its route out to the host URL
  // so the URL stays shareable and refreshable; an App beside keeps its
  // route to itself.
  const onRouteChange = (fragment: string) => {
    store.setRoute(slug, fragment);
    if (store.getSnapshot().front !== slug) return;
    const { latestLocation, state } = router;
    const resolved = state.resolvedLocation ?? state.location;
    // A navigation away from this App is in flight; don't override it.
    if (latestLocation.pathname !== resolved.pathname) return;
    const own = router.buildLocation({
      to: '/app/$appSlug',
      params: { appSlug: slug },
    });
    if (resolved.pathname !== own.pathname) return;
    if (
      canonicalRoute(fragment) ===
      canonicalRoute(rawFragment(latestLocation.href))
    )
      return;
    void router.navigate({
      to: '/app/$appSlug',
      params: { appSlug: slug },
      // The router writes `hash` into the URL verbatim, so pass it encoded.
      hash: fragment,
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
    });
  };

  // The surface reports on every change to the App's head, often with the
  // same title; equal values keep the state.
  const onTitleChange = (title: string | null) => setPageTitle(title);

  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      // Refetch through the query rather than invalidating the route: a failed
      // route loader replaces the whole view with an error state, while a
      // failed query refetch keeps the cached snapshot and its running App.
      const fresh = await queryClient.fetchQuery({
        ...appViewQueryOptions(slug),
        staleTime: 0,
      });
      // An App that can no longer run is stopped once the query settles.
      if (!canRun(fresh)) return;
      store.setRevision(slug, fresh.deploymentRevision);
      surface.current?.reload();
    } catch (error) {
      if (isNotFound(error)) {
        // The app was deleted or renamed: stop it, and in front let the
        // route's loader render not-found.
        const front = store.getSnapshot().front === slug;
        store.quit(slug);
        if (front) await router.invalidate();
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
      placement={placement}
      title={app.name}
      documentTitle={pageTitle || app.name}
      tile={<AppGlyph name={app.name} seed={app.id} size="sm" />}
      toolbar={
        <AppWindowToolbar
          slug={slug}
          canOpen
          updateAvailable={updateAvailable}
          reloading={reloading}
          onReload={reload}
        />
      }
      // Minimising (and Escape, and the back button) leaves the App running
      // on the desk; beside, it stops showing there. Close stops the App.
      onMinimise={() => {
        if (placement === 'beside') store.hideBeside();
      }}
      onClose={() => store.quit(slug)}
    >
      <AppSurface
        ref={surface}
        app={app}
        route={session.route}
        visible={placement !== 'hidden'}
        reservedShortcuts={app.reservedShortcuts}
        onRouteChange={onRouteChange}
        onTitleChange={onTitleChange}
        latestDeployment={updateAvailable ? pendingRevision : revision}
      />
    </DeskWindow>
  );
}
