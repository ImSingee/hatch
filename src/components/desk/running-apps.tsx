import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isNotFound, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { canRunApp } from '~components/apps/app-view-policy';
import { AppWindowToolbar } from '~components/apps/app-window-toolbar';
import { useAppDeploymentUpdate } from '~components/apps/use-app-deployment-update';
import { useErrorText } from '~i18n';
import { DEFAULT_BACKGROUND_APP_MINUTES } from '~/desk-preferences';
import { appViewQueryOptions } from '~queries/apps';
import { deskPreferencesQueryOptions } from '~queries/desk-preferences';
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
 * only its placement. A hidden App keeps running, listeners and all, until
 * its background time is up.
 */
export function RunningApps({ besideShown }: { besideShown: boolean }) {
  const store = useAppSessionStore();
  const { sessions, front } = useAppSessions();
  const beside = useVisibleBeside(besideShown);
  const onScreen = sessions
    .filter((session) => session.slug === front || session.slug === beside)
    .map((session) => session.key);
  const onScreenKey = onScreen.join('\n');

  // Re-run for a new session too: one that starts off screen (an App
  // restored beside a narrow window) starts its background time.
  const runningKeys = sessions.map((session) => session.key).join('\n');
  useEffect(() => {
    store.setVisible(onScreenKey ? onScreenKey.split('\n') : []);
  }, [store, onScreenKey, runningKeys]);

  // Stop Apps that waited in the background too long. Re-armed whenever the
  // running Apps, what is on screen or the background time change.
  const { data: preferences } = useQuery({
    ...deskPreferencesQueryOptions,
    enabled: store.backgroundTimeoutMs === undefined,
  });
  const timeoutMs =
    store.backgroundTimeoutMs ??
    (preferences?.backgroundAppMinutes ?? DEFAULT_BACKGROUND_APP_MINUTES) *
      60_000;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const due = store.stopWaiting(timeoutMs);
      if (due !== null) {
        timer = setTimeout(check, Math.max(0, due - Date.now()));
      }
    };
    check();
    return () => clearTimeout(timer);
  }, [store, timeoutMs, sessions, onScreenKey]);

  return sessions.map((session) => (
    <SessionWindow
      key={session.key}
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
  const queryClient = useQueryClient();
  const { slug, revision } = session;
  const { data: app, error } = useQuery(appViewQueryOptions(slug));

  // Deleted, renamed away or archived: stop it (in front, the App's page
  // then says why). A new deployment that cannot run here does not stop a
  // running frame: it keeps the bundle it loaded until a reload.
  const gone = isNotFound(error) || app?.status === 'archived';
  useEffect(() => {
    if (gone) store.quit(slug);
  }, [gone, store, slug]);

  useEffect(() => {
    // An App started without its details (restored beside after a reload)
    // reads its live deployment before it loads, and is judged on that read
    // alone: cached details may predate a deploy.
    if (revision !== undefined) return;
    let current = true;
    queryClient.fetchQuery({ ...appViewQueryOptions(slug), staleTime: 0 }).then(
      (fresh) => {
        if (!current) return;
        if (canRunApp(fresh)) {
          store.setLoaded(slug, {
            appId: fresh.id,
            revision: fresh.deploymentRevision,
          });
        } else {
          store.quit(slug);
        }
      },
      () => {
        // Not found, or unreachable: nothing to run. It was only restored,
        // so stopping it costs no unsaved state.
        if (current) store.quit(slug);
      },
    );
    return () => {
      current = false;
    };
  }, [queryClient, revision, store, slug]);

  if (!app || gone || revision === undefined) return null;
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
      store.register(session.key, {
        navigate: (route) => surface.current?.navigate(route),
      }),
    [store, session.key],
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
      // A reload applies the live deployment: one that cannot run here stops
      // the App (in front, its page then says why).
      if (!canRunApp(fresh)) {
        store.quit(slug);
        return;
      }
      const renamed = session.frameSlug !== slug;
      store.reloaded(slug, fresh.deploymentRevision);
      // A renamed App's frame source changes, which loads it afresh anyway.
      if (!renamed) surface.current?.reload();
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
        // The slug the running frame was loaded from: renaming the App keeps
        // the frame; the next reload uses the new slug.
        app={{ slug: session.frameSlug, name: app.name }}
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
