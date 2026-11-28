import { Button, Loader, Text } from '@mantine/core';
import { useRouter } from '@tanstack/react-router';
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useI18n } from '~i18n';
import { useSurfaceTheme } from '~/ui/theme';
import {
  type CssRect,
  nativeApps,
  onNativeAppEvent,
} from '~components/desktop-host/native-apps';
import type { AppSurfaceProps } from './app-surface';
import {
  dispatchPlatformChord,
  unreservedPlatformChords,
} from './platform-shortcuts';
import { trackSurface } from './native-surface-tracker';
import classes from './app-surface.module.css';

/** Keys stay unique across page loads: the app outlives this page. */
const PAGE = Math.random().toString(36).slice(2, 10);
let surfaces = 0;

/** The App's state; `key` names the engine (one per load) it is about. */
type Status =
  | { state: 'loading' }
  | { state: 'ready'; key: string; deploymentId: string }
  | { state: 'failed'; key: string | null; message: string };

/**
 * A `native` App inside the macOS app: the app runs it in an NSH view of its
 * own over this element (`desktop/src-tauri/src/native/`). The element keeps
 * the App's place in the layout and reports where it is and whether it
 * shows; while one of the page's overlays (a menu, a dialog, the search
 * palette) covers it, the element shows a picture of the App and the view
 * steps aside, because nothing of the page can draw over a native view.
 */
export function NativeAppSurface({
  ref,
  app,
  route,
  visible = true,
  reservedShortcuts,
  onRouteChange,
  onTitleChange,
  latestDeployment,
}: AppSurfaceProps & { app: { id: string } }) {
  const { t } = useI18n();
  const router = useRouter({ warn: false });
  const surfaceTheme = useSurfaceTheme();
  const element = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<Status>({ state: 'loading' });
  const key = status.state === 'ready' ? status.key : '';
  const restart = () => {
    setStatus({ state: 'loading' });
    setGeneration((current) => current + 1);
  };
  const [picture, setPicture] = useState<string | null>(null);
  const notified = useRef<string | null>(null);
  // A navigation asked for while the App loads, sent once it is ready.
  const pendingRoute = useRef<string | null>(null);

  const seedRoute = useEffectEvent(() => route);
  const currentShortcuts = useEffectEvent(() =>
    unreservedPlatformChords(reservedShortcuts ?? []),
  );
  const reportRoute = useEffectEvent((next: string) => onRouteChange?.(next));
  const reportTitle = useEffectEvent((title: string | null) =>
    onTitleChange?.(title),
  );
  const openApp = useEffectEvent((slug: string, next: string) => {
    if (router) {
      void router.navigate({
        to: '/app/$appSlug',
        params: { appSlug: slug },
        hash: next,
      });
    } else {
      window.location.assign(`/app/${encodeURIComponent(slug)}#${next}`);
    }
  });

  // One engine per load, under a key of its own: a reload stops the App and
  // starts it again, and a key the app saw closed never opens. As a frame
  // loads afresh when its slug changes (a renamed App's next reload), so
  // does the engine.
  useEffect(() => {
    const surfaceKey = `native-${PAGE}-${++surfaces}`;
    notified.current = null;
    const stop = onNativeAppEvent(surfaceKey, (event) => {
      switch (event.type) {
        case 'ready': {
          setStatus({
            state: 'ready',
            key: surfaceKey,
            deploymentId: event.deploymentId,
          });
          const next = pendingRoute.current;
          pendingRoute.current = null;
          if (next !== null) {
            void nativeApps.message(surfaceKey, {
              type: 'navigate',
              route: next,
            });
          }
          break;
        }
        case 'failed':
          setStatus({
            state: 'failed',
            key: surfaceKey,
            message: event.message,
          });
          break;
        case 'route':
          reportRoute(event.route);
          break;
        case 'title':
          reportTitle(event.title);
          break;
        case 'open':
          openApp(event.slug, event.route);
          break;
        case 'shortcut':
          dispatchPlatformChord(event.chord);
          break;
      }
    });
    nativeApps
      .open(surfaceKey, app.id, seedRoute(), currentShortcuts())
      .catch((error: unknown) =>
        setStatus({ state: 'failed', key: surfaceKey, message: String(error) }),
      );
    return () => {
      stop();
      void nativeApps.close(surfaceKey).catch(() => undefined);
    };
  }, [app.id, app.slug, generation]);

  const ready = key !== '';

  // Where the App is, whether it shows, and whether an overlay covers it.
  const showing = visible && ready;
  useEffect(() => {
    const node = element.current;
    if (!node || !key || !ready) return;
    let covered = false;
    let pending = 0;
    const cover = async (next: boolean) => {
      covered = next;
      const turn = ++pending;
      if (!next) {
        await nativeApps.cover(key, false);
        // The view shows again before the picture goes.
        requestAnimationFrame(() => {
          if (turn === pending) setPicture(null);
        });
        return;
      }
      try {
        const url = URL.createObjectURL(await nativeApps.snapshot(key));
        if (turn !== pending) {
          URL.revokeObjectURL(url);
          return;
        }
        setPicture(url);
      } catch {
        // No picture: the overlay still has to show.
      }
      if (turn === pending) await nativeApps.cover(key, true);
    };
    const stop = trackSurface(node, {
      place: (rect: CssRect, viewportWidth: number) =>
        void nativeApps.place(key, rect, viewportWidth, showing),
      covered: (next) => {
        if (next !== covered) void cover(next);
      },
    });
    return () => {
      stop();
      // The next tracker starts uncovered and may never see the overlay go
      // (the App hidden meanwhile): uncover now, and let no picture still
      // being taken cover it again.
      pending += 1;
      if (covered) {
        covered = false;
        void nativeApps.cover(key, false);
        setPicture(null);
      }
    };
  }, [key, ready, showing]);

  // A picture is a blob URL: free it once it is replaced or gone.
  useEffect(() => {
    if (!picture) return;
    return () => URL.revokeObjectURL(picture);
  }, [picture]);

  useEffect(() => {
    if (key && ready) void nativeApps.message(key, { type: 'theme' });
  }, [key, ready, surfaceTheme]);

  // A new deployment may reserve other shortcuts: the running App's key
  // monitor follows (also after a change while the App loaded), as a frame
  // reads them on every press.
  const shortcuts = JSON.stringify(
    unreservedPlatformChords(reservedShortcuts ?? []),
  );
  useEffect(() => {
    if (!key || !ready) return;
    void nativeApps.message(key, {
      type: 'shortcuts',
      shortcuts: JSON.parse(shortcuts) as string[],
    });
  }, [key, ready, shortcuts]);

  // "Update available" once the host's live deployment and the App's differ.
  useEffect(() => {
    if (
      status.state === 'ready' &&
      latestDeployment &&
      latestDeployment !== status.deploymentId &&
      notified.current !== latestDeployment
    ) {
      notified.current = latestDeployment;
      void nativeApps.message(key, { type: 'update-available' });
    }
  }, [key, status, latestDeployment]);

  useImperativeHandle(
    ref,
    () => ({
      reload: restart,
      navigate: (next) => {
        if (key) {
          void nativeApps.message(key, { type: 'navigate', route: next });
        } else {
          pendingRoute.current = next;
        }
      },
    }),
    [key],
  );

  return (
    <div className={classes.surface} hidden={!visible}>
      <div
        ref={element}
        className={classes.native}
        data-native-app-surface=""
        // Clicks on the picture (while an overlay covers the App) go nowhere.
        onPointerDown={() => key && ready && void nativeApps.focus(key)}
      >
        {picture ? (
          <img src={picture} alt="" className={classes.picture} />
        ) : null}
      </div>
      {status.state === 'loading' ? (
        <div className={classes.overlay}>
          <Loader />
        </div>
      ) : null}
      {status.state === 'failed' ? (
        <div className={classes.overlay}>
          <div className={classes.failure}>
            <Text size="sm">
              {t('desktop.nativeApp.failed', { message: status.message })}
            </Text>
            <Button type="button" variant="default" size="xs" onClick={restart}>
              {t('common.tryAgain')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
