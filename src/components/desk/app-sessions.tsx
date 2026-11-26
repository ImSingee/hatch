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
  /** Stable for the session's lifetime: its window's React key. */
  key: string;
  /** The App's current slug: its links and its details query use it. */
  slug: string;
  /**
   * The App's id, which survives a slug change; `undefined` until its
   * details are read (an App restored beside after a reload).
   */
  appId: string | undefined;
  /**
   * The slug the running frame was loaded from. It stays put when the App is
   * renamed, so the running frame is kept; a reload switches to `slug`.
   */
  frameSlug: string;
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
 * by a reload opens where it was left. Routes are kept in a `Map`: a slug
 * such as `constructor` must never read an inherited property.
 */
function readPersisted(storage: Storage | null) {
  const remembered = new Map<string, string>();
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    if (value.remembered && typeof value.remembered === 'object') {
      for (const [slug, route] of Object.entries(value.remembered)) {
        if (typeof route === 'string') remembered.set(slug, route);
      }
    }
    return {
      remembered,
      beside: typeof value.beside === 'string' ? value.beside : null,
    };
  } catch {
    return { remembered, beside: null };
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
  /** The App's id: a running App renamed since it started is found by it. */
  appId?: string;
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
 * focuses it, also under a new slug. A minimised App keeps running, its
 * listeners and all, until it has waited off screen for the background time
 * (a user preference, 5 minutes by default) or the limit needs its place
 * (the least recently shown goes first); it is then stopped (its window and
 * frame are removed) and its route remembered, so it reopens there.
 */
export class AppSessionStore {
  readonly limit: number;
  private snapshot: AppSessionsSnapshot;
  private readonly remembered: Map<string, string>;
  private clock = 0;
  private sessionCount = 0;
  /** Keys of the sessions on screen. */
  private visible = new Set<string>();
  /** When each session off screen was last hidden (ms since the epoch). */
  private readonly hiddenAt = new Map<string, number>();
  /** Fixed background time for tests; otherwise the browser preference. */
  readonly backgroundTimeoutMs: number | undefined;
  /** By session key. */
  private readonly handles = new Map<string, AppSessionHandle>();
  private readonly listeners = new Set<() => void>();
  private readonly storage: Storage | null;

  constructor({
    limit = WEB_RUNNING_APP_LIMIT,
    storage = sessionStorageOrNull(),
    besideEnabled = true,
    backgroundTimeoutMs,
  }: {
    limit?: number;
    storage?: Storage | null;
    besideEnabled?: boolean;
    backgroundTimeoutMs?: number;
  } = {}) {
    this.limit = Math.max(1, limit);
    this.backgroundTimeoutMs = backgroundTimeoutMs;
    this.storage = storage;
    const persisted = readPersisted(storage);
    this.remembered = persisted.remembered;
    const beside = besideEnabled ? persisted.beside : null;
    this.snapshot = {
      // An App left beside reopens beside, where it was.
      sessions: beside
        ? [this.newSession(beside, this.remembered.get(beside) ?? '', {})]
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
    this.adoptSlug(slug, request.appId);
    const wasFront = this.snapshot.front === slug;
    const beside = this.snapshot.beside === slug ? null : this.snapshot.beside;
    const running = this.session(slug);
    if (!running) {
      const seed =
        request.route === '' || request.focus
          ? (this.remembered.get(slug) ?? request.route)
          : request.route;
      this.start(this.newSession(slug, seed, request), { front: slug, beside });
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
    this.moveTo(running, request.route);
    return null;
  }

  /** The URL no longer shows `slug` in front. */
  leaveFront(slug: string) {
    if (this.snapshot.front === slug) this.commit({ front: null });
  }

  /**
   * Show `slug` beside the window in front, starting it if needed. The
   * caller has read the App's live details (`appId`, `revision`) and found it
   * runnable, so nothing is stopped for an App that cannot open.
   */
  openBeside(
    slug: string,
    app: { appId: string; revision: string | null; route?: string },
  ) {
    this.adoptSlug(slug, app.appId);
    if (this.snapshot.front === slug) return;
    if (this.session(slug)) {
      this.commit({ beside: slug });
      return;
    }
    const route = this.remembered.get(slug) ?? app.route ?? '';
    this.start(this.newSession(slug, route, app), { beside: slug });
  }

  /** Stop showing anything beside; that App keeps running. */
  hideBeside() {
    if (this.snapshot.beside) this.commit({ beside: null });
  }

  /** Stop `slug`: its frame goes away and it will start fresh next time. */
  quit(slug: string) {
    const session = this.session(slug);
    if (!session) return;
    this.remembered.delete(slug);
    this.handles.delete(session.key);
    this.hiddenAt.delete(session.key);
    this.commit({
      sessions: this.snapshot.sessions.filter((s) => s !== session),
      beside: this.snapshot.beside === slug ? null : this.snapshot.beside,
      front: this.snapshot.front === slug ? null : this.snapshot.front,
    });
  }

  /** Stop the App with this id, under whichever slug it runs. */
  quitApp(appId: string, slug: string) {
    const running =
      this.snapshot.sessions.find((s) => s.appId === appId) ??
      this.snapshot.sessions.find((s) => s.slug === slug && !s.appId);
    if (running) this.quit(running.slug);
  }

  /** The App moved to `route` by itself. */
  setRoute(slug: string, route: string) {
    const session = this.session(slug);
    if (!session || session.route === route) return;
    this.update(session, { route });
  }

  /** The App's details were read: what the running frame loaded. */
  setLoaded(slug: string, app: { appId: string; revision: string | null }) {
    const session = this.session(slug);
    if (
      !session ||
      (session.revision === app.revision && session.appId === app.appId)
    ) {
      return;
    }
    this.update(session, { appId: app.appId, revision: app.revision });
  }

  /** The surface reloads the App, now under its current slug. */
  reloaded(slug: string, revision: string | null) {
    const session = this.session(slug);
    if (!session) return;
    this.update(session, { revision, frameSlug: slug });
  }

  /** Lets the store move a running App to another route. */
  register(key: string, handle: AppSessionHandle) {
    this.handles.set(key, handle);
    return () => {
      if (this.handles.get(key) === handle) this.handles.delete(key);
    };
  }

  /**
   * Which sessions (by key) are on screen now. Sessions that appear or
   * disappear are stamped, so "least recently shown" counts an App as shown
   * until it was hidden, and an App off screen starts its background time.
   */
  setVisible(keys: readonly string[], now = Date.now()) {
    const next = new Set(keys);
    for (const session of this.snapshot.sessions) {
      if (next.has(session.key)) this.hiddenAt.delete(session.key);
      else if (!this.hiddenAt.has(session.key)) {
        this.hiddenAt.set(session.key, now);
      }
    }
    const changed = this.snapshot.sessions.filter(
      (s) => next.has(s.key) !== this.visible.has(s.key),
    );
    this.visible = next;
    if (changed.length === 0) return;
    const shownAt = this.tick();
    const stamped = new Set(changed);
    this.commit({
      sessions: this.snapshot.sessions.map((s) =>
        stamped.has(s) ? { ...s, shownAt } : s,
      ),
    });
  }

  /**
   * Stops every App that has waited off screen for `timeoutMs` or longer,
   * remembering its route, as the limit does. Returns when the next waiting
   * App is due, or `null` when none waits.
   */
  stopWaiting(timeoutMs: number, now = Date.now()): number | null {
    const due = (session: AppSession) => {
      const since = this.hiddenAt.get(session.key);
      return since === undefined ? null : since + timeoutMs;
    };
    const expired = this.snapshot.sessions.filter((session) => {
      const at = due(session);
      return at !== null && at <= now;
    });
    if (expired.length > 0) {
      let beside = this.snapshot.beside;
      for (const session of expired) {
        this.remembered.set(session.slug, session.route);
        this.handles.delete(session.key);
        this.hiddenAt.delete(session.key);
        if (session.slug === beside) beside = null;
      }
      this.commit({
        sessions: this.snapshot.sessions.filter((s) => !expired.includes(s)),
        beside,
      });
    }
    let next: number | null = null;
    for (const session of this.snapshot.sessions) {
      const at = due(session);
      if (at !== null && (next === null || at < next)) next = at;
    }
    return next;
  }

  /**
   * A running App renamed since it started: carry its session (and its
   * place in front or beside) over to the new slug, so it is not started a
   * second time and nothing links to the old slug.
   */
  private adoptSlug(slug: string, appId: string | undefined) {
    if (!appId) return;
    const holder = this.session(slug);
    if (holder?.appId === appId || (holder && !holder.appId)) return;
    if (holder) {
      // Another App that ran under this slug before it was renamed: its new
      // slug is unknown here, so stop it rather than show it as this App.
      this.quit(slug);
    }
    const renamed = this.snapshot.sessions.find((s) => s.appId === appId);
    if (!renamed) return;
    const old = renamed.slug;
    this.remembered.delete(old);
    const rename = (value: string | null) => (value === old ? slug : value);
    this.commit({
      sessions: this.snapshot.sessions.map((s) =>
        s === renamed ? { ...s, slug } : s,
      ),
      front: rename(this.snapshot.front),
      beside: rename(this.snapshot.beside),
    });
  }

  private moveTo(session: AppSession, route: string) {
    if (canonicalRoute(session.route) !== canonicalRoute(route)) {
      this.update(session, { route });
    }
    // Always tell the App: the route it last reported may lag its own.
    this.handles.get(session.key)?.navigate(route);
  }

  private newSession(
    slug: string,
    route: string,
    app: { appId?: string; revision?: string | null },
  ): AppSession {
    this.sessionCount += 1;
    return {
      key: `app-session-${this.sessionCount}`,
      slug,
      appId: app.appId,
      frameSlug: slug,
      route,
      revision: app.revision,
      shownAt: this.tick(),
    };
  }

  private start(
    session: AppSession,
    layout: Partial<Pick<AppSessionsSnapshot, 'front' | 'beside'>>,
  ) {
    let beside =
      layout.beside === undefined ? this.snapshot.beside : layout.beside;
    let sessions = [...this.snapshot.sessions];
    while (sessions.length >= this.limit) {
      const victim = this.leastRecentlyShown(sessions);
      if (!victim) break;
      this.remembered.set(victim.slug, victim.route);
      this.handles.delete(victim.key);
      this.hiddenAt.delete(victim.key);
      sessions = sessions.filter((s) => s !== victim);
      if (victim.slug === beside) beside = null;
    }
    sessions.push(session);
    this.commit({ ...layout, beside, sessions });
  }

  /**
   * The App to stop for a new one: the one shown least recently. An App on
   * screen counts as shown now; one kept beside but hidden (a narrow window)
   * ranks by when it was last shown, like any other.
   */
  private leastRecentlyShown(sessions: readonly AppSession[]) {
    const shownAt = (session: AppSession) =>
      this.visible.has(session.key)
        ? Number.POSITIVE_INFINITY
        : session.shownAt;
    let victim: AppSession | null = null;
    for (const session of sessions) {
      if (!victim || shownAt(session) < shownAt(victim)) victim = session;
    }
    return victim;
  }

  private update(session: AppSession, patch: Partial<AppSession>) {
    this.commit({
      sessions: this.snapshot.sessions.map((s) =>
        s === session ? { ...s, ...patch } : s,
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
      this.remembered.set(session.slug, session.route);
    }
    this.persist();
    for (const listener of this.listeners) listener();
  }

  private persist() {
    try {
      this.storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({
          remembered: Object.fromEntries(this.remembered),
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
  backgroundTimeoutMs,
  children,
}: {
  limit?: number;
  /** Whether an App can be shown beside another window here. */
  besideEnabled?: boolean;
  /** Overrides the browser's background-time preference (tests). */
  backgroundTimeoutMs?: number;
  children: ReactNode;
}) {
  const [store] = useState(
    () => new AppSessionStore({ limit, besideEnabled, backgroundTimeoutMs }),
  );
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
