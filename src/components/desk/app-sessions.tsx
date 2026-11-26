import {
  type ReactNode,
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from 'react';
import { canonicalRoute } from './app-surface';

declare module '@tanstack/react-router' {
  interface HistoryState {
    /**
     * Set by a link that brings a running App forward as it is (a dock
     * tile, All apps) instead of moving it to the link's route.
     */
    appFocus?: boolean;
  }
}

/**
 * How many Apps one Desk window keeps running on the web: plan section 3.6.
 * Opening one more stops the App shown least recently.
 */
export const WEB_RUNNING_APP_LIMIT = 12;

/** One running App: one mounted `AppSurface`, kept while it is hidden. */
export type AppSession = {
  slug: string;
  /**
   * The App's route as it last reported it (or as it was told to go), still
   * percent-encoded; '' is its home. A (re)load opens here.
   */
  route: string;
  /**
   * The deployment revision the surface loaded, the baseline for "has
   * update". `undefined` until the App's details are read; a reload resets
   * it. Never moved by a later read of the App, because the running frame
   * keeps the bundle it loaded.
   */
  revision: string | null | undefined;
  /** When the App was last shown (a tick of the store's clock). */
  shownAt: number;
};

export type AppSessionsSnapshot = {
  /**
   * The running Apps in the order they were opened. Rendered in this order
   * and only appended to, so a frame never moves in the document (moving an
   * iframe reloads it).
   */
  sessions: readonly AppSession[];
  /**
   * The App whose window is in front: the one the host URL opens. `null`
   * while the URL shows another page (or the desk).
   */
  front: string | null;
  /** The App shown beside the window in front, if any. */
  beside: string | null;
};

/** What a session's window lets the store reach in its running App. */
export type AppSessionHandle = { navigate: (route: string) => void };

type Persisted = {
  remembered: Record<string, string>;
  beside: string | null;
};

const STORAGE_KEY = 'hatch.desk.apps';

/**
 * Per browser window, like a tab's history: which App sits beside, and the
 * last route of every App this window ran, so an App stopped by the limit or
 * by a reload opens where it was left.
 */
function readPersisted(storage: Storage | null): Persisted {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    const remembered: Record<string, string> = {};
    if (value.remembered && typeof value.remembered === 'object') {
      for (const [slug, route] of Object.entries(value.remembered)) {
        if (typeof route === 'string') remembered[slug] = route;
      }
    }
    return {
      remembered,
      beside: typeof value.beside === 'string' ? value.beside : null,
    };
  } catch {
    return { remembered: {}, beside: null };
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export type ShowRequest = {
  /** The host URL's route for the App, still percent-encoded. */
  route: string;
  /**
   * Bring a running App forward as it is rather than moving it to `route`
   * (an App opened from the dock, All apps or a bare link). A route is still
   * followed when the App is already in front: selecting its pin again
   * returns it to the pin's page.
   */
  focus: boolean;
  /** The live deployment revision, when the caller just read it. */
  revision?: string | null;
};

/**
 * The Desk's session manager: which Apps are running in this browser
 * window, in what order they were last shown, and what sits beside the
 * window in front. Which App is in front is the URL's; the store only notes
 * it to tell a fresh focus from a navigation inside the App in front.
 *
 * Every running App has one session, so opening an App that runs already
 * focuses it. Past the limit the least recently shown App is stopped (its
 * window and frame are removed) and its route remembered.
 */
export class AppSessionStore {
  readonly limit: number;
  private snapshot: AppSessionsSnapshot;
  private remembered: Record<string, string>;
  private clock = 0;
  private visible = new Set<string>();
  private readonly handles = new Map<string, AppSessionHandle>();
  private readonly listeners = new Set<() => void>();
  private readonly storage: Storage | null;

  constructor({
    limit = WEB_RUNNING_APP_LIMIT,
    storage = sessionStorageOrNull(),
    besideEnabled = true,
  }: {
    limit?: number;
    storage?: Storage | null;
    besideEnabled?: boolean;
  } = {}) {
    this.limit = Math.max(1, limit);
    this.storage = storage;
    const persisted = readPersisted(storage);
    this.remembered = persisted.remembered;
    const beside = besideEnabled ? persisted.beside : null;
    this.snapshot = {
      // An App left beside reopens beside, where it was.
      sessions: beside
        ? [
            {
              slug: beside,
              route: this.remembered[beside] ?? '',
              revision: undefined,
              shownAt: this.tick(),
            },
          ]
        : [],
      front: null,
      beside,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  /** The session of `slug`, if that App is running. */
  session(slug: string) {
    return this.snapshot.sessions.find((session) => session.slug === slug);
  }

  /**
   * Show `slug` in front for the host URL. Starts it when it is not running
   * (at `route`, or where it was left when the URL names no route), focuses
   * it when it is. Returns the route the host URL should show instead of its
   * own, if any.
   */
  show(slug: string, request: ShowRequest): string | null {
    const wasFront = this.snapshot.front === slug;
    const beside = this.snapshot.beside === slug ? null : this.snapshot.beside;
    const running = this.session(slug);
    if (!running) {
      const seed =
        request.route === '' || request.focus
          ? (this.remembered[slug] ?? request.route)
          : request.route;
      this.start(slug, seed, request.revision, { front: slug, beside });
      return canonicalRoute(seed) === canonicalRoute(request.route)
        ? null
        : seed;
    }
    if (!wasFront || beside !== this.snapshot.beside) {
      this.commit({ front: slug, beside });
    }
    if (!wasFront && (request.focus || request.route === '')) {
      // Brought forward: keep its screen, and put its route in the URL.
      return canonicalRoute(running.route) === canonicalRoute(request.route)
        ? null
        : running.route;
    }
    this.moveTo(slug, request.route);
    return null;
  }

  /** The URL no longer shows `slug` in front. */
  leaveFront(slug: string) {
    if (this.snapshot.front === slug) this.commit({ front: null });
  }

  /** Show `slug` beside the window in front, starting it if needed. */
  openBeside(slug: string, route = '') {
    if (this.snapshot.front === slug) return;
    if (this.session(slug)) {
      this.commit({ beside: slug });
      return;
    }
    this.start(slug, this.remembered[slug] ?? route, undefined, {
      beside: slug,
    });
  }

  /** Stop showing anything beside; that App keeps running. */
  hideBeside() {
    if (this.snapshot.beside) this.commit({ beside: null });
  }

  /** Stop `slug`: its frame goes away and it will start fresh next time. */
  quit(slug: string) {
    if (!this.session(slug)) return;
    delete this.remembered[slug];
    this.handles.delete(slug);
    this.commit({
      sessions: this.snapshot.sessions.filter((s) => s.slug !== slug),
      beside: this.snapshot.beside === slug ? null : this.snapshot.beside,
      front: this.snapshot.front === slug ? null : this.snapshot.front,
    });
  }

  /** The App moved to `route` by itself. */
  setRoute(slug: string, route: string) {
    const session = this.session(slug);
    if (!session || session.route === route) return;
    this.update(slug, { route });
  }

  /** The surface (re)loaded the App's `revision`. */
  setRevision(slug: string, revision: string | null) {
    const session = this.session(slug);
    if (!session || session.revision === revision) return;
    this.update(slug, { revision });
  }

  /** Lets the store move a running App to another route. */
  register(slug: string, handle: AppSessionHandle) {
    this.handles.set(slug, handle);
    return () => {
      if (this.handles.get(slug) === handle) this.handles.delete(slug);
    };
  }

  /**
   * Which Apps are on screen now. Apps that appear or disappear are stamped,
   * so "least recently shown" counts an App as shown until it was hidden.
   */
  setVisible(slugs: readonly string[]) {
    const next = new Set(slugs);
    const changed = this.snapshot.sessions.filter(
      (s) => next.has(s.slug) !== this.visible.has(s.slug),
    );
    this.visible = next;
    if (changed.length === 0) return;
    const shownAt = this.tick();
    const stamped = new Set(changed.map((s) => s.slug));
    this.commit({
      sessions: this.snapshot.sessions.map((s) =>
        stamped.has(s.slug) ? { ...s, shownAt } : s,
      ),
    });
  }

  private moveTo(slug: string, route: string) {
    const session = this.session(slug);
    if (!session) return;
    if (canonicalRoute(session.route) !== canonicalRoute(route)) {
      this.update(slug, { route });
    }
    // Always tell the App: the route it last reported may lag its own.
    this.handles.get(slug)?.navigate(route);
  }

  private start(
    slug: string,
    route: string,
    revision: string | null | undefined,
    layout: Partial<Pick<AppSessionsSnapshot, 'front' | 'beside'>>,
  ) {
    const beside =
      layout.beside === undefined ? this.snapshot.beside : layout.beside;
    let sessions = [...this.snapshot.sessions];
    while (sessions.length >= this.limit) {
      const victim = this.leastRecentlyShown(sessions, beside);
      if (!victim) break;
      this.remembered[victim.slug] = victim.route;
      this.handles.delete(victim.slug);
      sessions = sessions.filter((s) => s !== victim);
    }
    sessions.push({ slug, route, revision, shownAt: this.tick() });
    this.commit({ ...layout, sessions });
  }

  /** The App to stop for a new one: never one on screen or kept beside. */
  private leastRecentlyShown(
    sessions: readonly AppSession[],
    beside: string | null,
  ) {
    let victim: AppSession | null = null;
    for (const session of sessions) {
      if (session.slug === beside) continue;
      // An App on screen counts as shown now.
      const shownAt = this.visible.has(session.slug)
        ? Number.POSITIVE_INFINITY
        : session.shownAt;
      if (
        !victim ||
        shownAt <
          (this.visible.has(victim.slug)
            ? Number.POSITIVE_INFINITY
            : victim.shownAt)
      ) {
        victim = session;
      }
    }
    return victim;
  }

  private update(slug: string, patch: Partial<AppSession>) {
    this.commit({
      sessions: this.snapshot.sessions.map((s) =>
        s.slug === slug ? { ...s, ...patch } : s,
      ),
    });
  }

  private tick() {
    this.clock += 1;
    return this.clock;
  }

  private commit(patch: Partial<AppSessionsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const session of this.snapshot.sessions) {
      this.remembered[session.slug] = session.route;
    }
    this.persist();
    for (const listener of this.listeners) listener();
  }

  private persist() {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          remembered: this.remembered,
          beside: this.snapshot.beside,
        } satisfies Persisted),
      );
    } catch {
      // Storage blocked: routes are remembered until the page reloads.
    }
  }
}

const AppSessionsContext = createContext<AppSessionStore | null>(null);

/** Gives the signed-in layout one session manager for its lifetime. */
export function AppSessionsProvider({
  limit,
  besideEnabled,
  children,
}: {
  limit?: number;
  /** Whether an App can be shown beside another window here. */
  besideEnabled?: boolean;
  children: ReactNode;
}) {
  const [store] = useState(() => new AppSessionStore({ limit, besideEnabled }));
  return (
    <AppSessionsContext.Provider value={store}>
      {children}
    </AppSessionsContext.Provider>
  );
}

export function useAppSessionStore() {
  const store = useContext(AppSessionsContext);
  if (!store) {
    throw new Error('useAppSessionStore must be used inside the desk.');
  }
  return store;
}

/** The store if there is one: pages also render outside the desk. */
export function useOptionalAppSessionStore() {
  return useContext(AppSessionsContext);
}

const EMPTY: AppSessionsSnapshot = { sessions: [], front: null, beside: null };
const noSubscription = () => () => {};

export function useAppSessions(): AppSessionsSnapshot {
  const store = useOptionalAppSessionStore();
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? (() => EMPTY),
  );
}
