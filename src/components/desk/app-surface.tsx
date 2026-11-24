import { Loader } from '@mantine/core';
import { useRouter } from '@tanstack/react-router';
import {
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  NATIVE_RUNTIME_META,
  NATIVE_SURFACE_PROTOCOL,
  parsePlayerMessage,
  type SurfaceMessage,
} from '../../../sdk-internal/app/src/native-surface';
import { useOptionalPlatformEvent } from '~components/system/platform-events-context';
import { useAccent } from '~/ui/theme';
import { appSurfaceSource } from './app-surface-source';
import classes from './app-surface.module.css';

/** What a host can ask of a running App. */
export type AppSurfaceHandle = {
  /** Loads the App again from scratch, at the surface's current `route`. */
  reload: () => void;
  /** Moves the running App to `route` without adding a history entry. */
  navigate: (route: string) => void;
};

export type AppSurfaceProps = {
  ref?: Ref<AppSurfaceHandle>;
  /** The App this surface runs. A surface runs one App for its lifetime. */
  app: { slug: string; name: string };
  /**
   * The route inside the App to open when it loads or reloads; '' is the
   * App's home. Routes cross this interface still percent-encoded, exactly as
   * they appear in a URL fragment: decoding would turn an escaped `%2520`
   * into `%20` and change what the route points at.
   */
  route: string;
  /** A hidden surface keeps its App running. */
  visible?: boolean;
  /** The App moved to another route by itself. */
  onRouteChange?: (route: string) => void;
  /** The App's own title changed; `null` when it has none. */
  onTitleChange?: (title: string | null) => void;
};

/** The still percent-encoded fragment of an href, without '#'. */
function rawFragment(href: string) {
  const index = href.indexOf('#');
  return index < 0 ? '' : href.slice(index + 1);
}

/**
 * Comparison key for routes: encodes what a URL would encode, but never
 * decodes existing escapes, so distinct routes never compare equal.
 */
export function canonicalRoute(route: string) {
  return new URL(`#${route}`, 'http://fragment.invalid').hash.slice(1);
}

// The URL must be absolute (a relative one resolves against the calling host
// document) and keep its '#' even when empty, so it stays a same-document
// fragment change.
function replaceInnerRoute(win: Window, route: string) {
  const [base] = win.location.href.split('#');
  win.location.replace(`${base}#${route}`);
}

/** Whether the loaded frame is a native App's player page. */
function isNativePlayer(doc: Document): boolean {
  return (
    doc
      .querySelector(`meta[name="${NATIVE_RUNTIME_META}"]`)
      ?.getAttribute('content') === 'native'
  );
}

/** The open channel to a native App's player, while one is loaded. */
type NativeChannel = {
  port: MessagePort;
  /** The route the App last reported, to skip echoing it back. */
  route: string;
  /** The App and deployment the player runs, from its `hello`. */
  appId: string | null;
  deploymentId: string | null;
  send: (message: SurfaceMessage) => void;
};

/**
 * Hosts one running App inside a Desk window. It is the only component that
 * knows how an App is rendered: today a same-origin frame, later an NSH
 * player. Nothing about the frame crosses this interface. A host loads an App
 * by mounting the surface, closes it by unmounting, and otherwise uses
 * `route`, `visible`, the two callbacks and the handle.
 *
 * A `web` App ships no bridge script, so its route and title are observed on
 * the same-origin frame from in here. A `native` App's frame is the NSH
 * player page, which marks itself with a meta tag; for it, route, title,
 * theme, visibility and "update available" go over a `postMessage` channel
 * (`sdk-internal/app/src/native-surface.ts`) instead.
 */
export function AppSurface({
  ref,
  app,
  route,
  visible = true,
  onRouteChange,
  onTitleChange,
}: AppSurfaceProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The live App window, kept so `navigate` can reach the loaded App.
  const winRef = useRef<Window | null>(null);
  const nativeRef = useRef<NativeChannel | null>(null);
  const accent = useAccent();
  const router = useRouter({ warn: false });
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const src = appSurfaceSource(app.slug);

  // The load handler and the App's own navigation events outlive the render
  // that subscribed them; these always see the newest props.
  const seedRoute = useEffectEvent(() => route);
  const reportRoute = useEffectEvent((next: string) => onRouteChange?.(next));
  const reportTitleChange = useEffectEvent((title: string | null) =>
    onTitleChange?.(title),
  );
  const currentAccent = useEffectEvent(() => accent);
  const currentVisible = useEffectEvent(() => visible);
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

  // The instance accent and the surface's visibility reach a native App
  // live; a `web` App reads neither.
  useEffect(() => {
    nativeRef.current?.send({ type: 'theme', accent });
  }, [accent]);
  useEffect(() => {
    nativeRef.current?.send({ type: 'visibility', visible });
  }, [visible]);
  useOptionalPlatformEvent('app.deployment.activated', (event) => {
    const channel = nativeRef.current;
    // Every App's activations reach every surface; only this App's newer
    // deployment is an update for it.
    if (
      channel?.deploymentId &&
      event.appId === channel.appId &&
      event.deploymentRevision !== channel.deploymentId &&
      winRef.current
    ) {
      channel.send({ type: 'update-available' });
    }
  });

  useImperativeHandle(
    ref,
    () => ({
      reload: () => setGeneration((current) => current + 1),
      navigate: (next) => {
        const channel = nativeRef.current;
        if (channel) {
          if (canonicalRoute(channel.route) !== canonicalRoute(next)) {
            channel.route = next;
            channel.send({ type: 'navigate', route: next });
          }
          return;
        }
        const win = winRef.current;
        if (!win) return;
        try {
          if (
            canonicalRoute(rawFragment(win.location.href)) !==
            canonicalRoute(next)
          ) {
            replaceInnerRoute(win, next);
          }
        } catch {
          // cross-origin frame
        }
      },
    }),
    [],
  );

  // Report the App's route and title to the host. Also clears the loading
  // overlay: on a direct load the frame can finish before this effect runs,
  // so the native `load` event would be missed; the already-complete check
  // below handles that case.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    setLoading(true);
    let win: Window | null = null;
    let titleObserver: MutationObserver | null = null;

    const reportTitle = () => {
      try {
        reportTitleChange(frame.contentDocument?.title || null);
      } catch {
        // cross-origin frame
      }
    };

    const onInnerChange = () => {
      try {
        if (win) reportRoute(rawFragment(win.location.href));
      } catch {
        // cross-origin frame
      }
      reportTitle();
    };

    // Hash routers usually navigate with `history.pushState`, which never
    // fires `hashchange`; the Navigation API reports every same-document
    // change. Without it, fall back to the events fragment and history
    // traversals fire.
    const innerEvents = (target: Window) =>
      target.navigation
        ? ([[target.navigation, 'currententrychange']] as const)
        : ([
            [target, 'popstate'],
            [target, 'hashchange'],
          ] as const);

    const detach = () => {
      try {
        if (win) {
          for (const [target, type] of innerEvents(win)) {
            target.removeEventListener(type, onInnerChange);
          }
        }
      } catch {
        // window already torn down
      }
      titleObserver?.disconnect();
      titleObserver = null;
      win = null;
      winRef.current = null;
      if (nativeRef.current) {
        nativeRef.current.port.close();
        nativeRef.current = null;
      }
    };

    // A native App: hand the player a private port, then talk only over it.
    const attachNative = (next: Window) => {
      const { port1, port2 } = new MessageChannel();
      const channel: NativeChannel = {
        port: port1,
        route: seedRoute(),
        appId: null,
        deploymentId: null,
        send: (message) => port1.postMessage(message),
      };
      nativeRef.current = channel;
      port1.onmessage = (event) => {
        const message = parsePlayerMessage(event.data);
        if (!message || nativeRef.current !== channel) return;
        switch (message.type) {
          case 'hello':
            channel.appId = message.appId;
            channel.deploymentId = message.deploymentId;
            break;
          case 'route':
            channel.route = message.route;
            reportRoute(message.route);
            break;
          case 'title':
            reportTitleChange(message.title);
            break;
          case 'open':
            openApp(message.slug, message.route);
            break;
        }
      };
      next.postMessage(
        { protocol: NATIVE_SURFACE_PROTOCOL, type: 'connect' },
        window.location.origin,
        [port2],
      );
      channel.send({
        type: 'init',
        route: channel.route,
        accent: currentAccent(),
        visible: currentVisible(),
      });
    };

    const onLoad = () => {
      const next = frame.contentWindow;
      if (!next) return;
      try {
        // Skip the frame's transient initial `about:blank` document; the real
        // load fires its own `load` event right after.
        if (next.location.href === 'about:blank') return;
      } catch {
        // cross-origin: can't sync, but the App did load — clear the overlay.
        setLoading(false);
        return;
      }
      setLoading(false);
      detach();
      win = next;
      winRef.current = next;
      try {
        const doc = frame.contentDocument;
        if (!doc) return;
        if (isNativePlayer(doc)) {
          attachNative(next);
          return;
        }
        // Deep link: seed the freshly loaded App with the host's route once,
        // before listening, so it doesn't immediately echo back out.
        const seed = seedRoute();
        if (
          seed &&
          canonicalRoute(rawFragment(next.location.href)) !==
            canonicalRoute(seed)
        ) {
          replaceInnerRoute(next, seed);
        }
        for (const [target, type] of innerEvents(next)) {
          target.addEventListener(type, onInnerChange);
        }
        const head = doc.head ?? doc.documentElement;
        if (head) {
          titleObserver = new MutationObserver(reportTitle);
          titleObserver.observe(head, {
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
        onInnerChange();
      } catch {
        // cross-origin frame
      }
    };

    frame.addEventListener('load', onLoad);
    try {
      if (frame.contentDocument?.readyState === 'complete') onLoad();
    } catch {
      // cross-origin frame
    }

    return () => {
      frame.removeEventListener('load', onLoad);
      detach();
    };
  }, [generation, src]);

  return (
    <div className={classes.surface} hidden={!visible}>
      <iframe
        // A fresh element per load: reusing it would briefly expose the
        // previous document as already loaded.
        key={`${src}:${generation}`}
        ref={frameRef}
        src={src}
        title={app.name}
        className={classes.frame}
      />
      {loading ? (
        <div className={classes.overlay}>
          <Loader />
        </div>
      ) : null}
    </div>
  );
}
