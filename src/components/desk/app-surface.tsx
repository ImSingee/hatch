import { Loader } from '@mantine/core';
import {
  type Ref,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { appSurfaceSource } from './app-surface-source';
import { attachPlatformShortcuts } from './platform-shortcuts';
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
  /**
   * Chords the App handles itself (its manifest's `keyboard.reserve`). Every
   * other platform shortcut keeps working while focus is inside the App.
   */
  reservedShortcuts?: readonly string[];
  /** The App moved to another route by itself. */
  onRouteChange?: (route: string) => void;
  /** The App's own title changed; `null` when it has none. */
  onTitleChange?: (title: string | null) => void;
};

const NO_RESERVED_SHORTCUTS: readonly string[] = [];

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

/**
 * Hosts one running App inside a Desk window. It is the only component that
 * knows how an App is rendered: today a same-origin frame, later an NSH
 * player. Nothing about the frame crosses this interface. A host loads an App
 * by mounting the surface, closes it by unmounting, and otherwise uses
 * `route`, `visible`, `reservedShortcuts`, the two callbacks and the handle.
 *
 * Apps ship no bridge script, so route and title are still observed, and
 * platform shortcuts caught, on the same-origin frame from in here. Once Apps
 * are served from their own origin that becomes a `postMessage` exchange
 * inside this file; the App side then needs the platform's chords minus its
 * reservations up front, because it must decide to cancel a key press
 * synchronously.
 */
export function AppSurface({
  ref,
  app,
  route,
  visible = true,
  reservedShortcuts = NO_RESERVED_SHORTCUTS,
  onRouteChange,
  onTitleChange,
}: AppSurfaceProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The live App window, kept so `navigate` can reach the loaded App.
  const winRef = useRef<Window | null>(null);
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
  const currentReservedShortcuts = useEffectEvent(() => reservedShortcuts);

  useImperativeHandle(
    ref,
    () => ({
      reload: () => setGeneration((current) => current + 1),
      navigate: (next) => {
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
    let detachShortcuts: (() => void) | null = null;

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
      detachShortcuts?.();
      detachShortcuts = null;
      win = null;
      winRef.current = null;
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
        detachShortcuts = attachPlatformShortcuts(next, () =>
          currentReservedShortcuts(),
        );
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
