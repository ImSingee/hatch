/**
 * The App's route and title, kept with the shell that runs it: the route the
 * shell opened the App at (`host.params.route`), the routes the App shows
 * (`hatch.nav.setRoute`, so deep links and reloads land on the same screen),
 * the shell's navigation requests (the `hatch.nav` event) and the page title
 * (`hatch.nav.setTitle`). `AppShell`, `NavStack` and `Page` use it, so an App
 * gets all of this without calling the bridge itself.
 *
 * The calls are the ones `@hatch/app/native` makes (`initialRoute`,
 * `setRoute`, `onNavigate`, `setTitle`), made here on `host` directly so the
 * library needs no other package; both carry the same names and payloads.
 * A refused or unavailable call changes nothing on screen.
 */
import { context, effect, host, signal, untracked } from 'nsh';

/** A route: `/`, `/notes` or `/notes/42`; the raw, percent-encoded path. */
export type RoutePath = string;

/** `''`, `#` and a missing leading `/` all mean the same path. */
export function normalizeRoute(route: string): RoutePath {
  const bare = route.startsWith('#') ? route.slice(1) : route;
  if (bare === '' || bare === '/') return '/';
  return bare.startsWith('/') ? bare : `/${bare}`;
}

/** The first segment of a path and the rest: `/a/b` -> `['a', '/b']`. */
export function firstSegment(path: RoutePath): [string, RoutePath] {
  const trimmed = normalizeRoute(path).slice(1);
  if (trimmed === '') return ['', ''];
  const slash = trimmed.indexOf('/');
  return slash < 0
    ? [trimmed, '']
    : [trimmed.slice(0, slash), trimmed.slice(slash)];
}

function call(name: string, data: unknown): void {
  if (!host.available()) return;
  try {
    void host.call(name, data).catch(() => undefined);
  } catch {
    // A shell without the call keeps its own route and title.
  }
}

type RootRoute = {
  current: () => RoutePath;
  report: (path: RoutePath) => void;
};

let root: RootRoute | undefined;

/** The App-wide route, made on first use. */
function rootRoute(): RootRoute {
  if (root) return root;
  const opened = host.available() ? host.params.route : undefined;
  const current = signal<RoutePath>(
    normalizeRoute(typeof opened === 'string' ? opened : ''),
  );
  if (host.available()) {
    host.on('hatch.nav', (payload) => {
      const route = (payload as { route?: unknown } | null)?.route;
      if (typeof route === 'string') current.set(normalizeRoute(route));
    });
  }
  root = {
    current,
    report(path) {
      const next = normalizeRoute(path);
      if (next === untracked(current)) return;
      current.set(next);
      call('hatch.nav.setRoute', { route: next });
    },
  };
  return root;
}

/**
 * What a component sees of the route: the part of the path that is its own
 * (`AppShell` takes the first segment, a `NavStack` inside a section the
 * rest), how it reports a change, and whether it is on screen (the selected
 * section, the top page of a stack). Hidden content never reports a route or
 * a title.
 */
export type ShellScope = {
  /** This level's part of the route, `''` when it has none. */
  route: () => RoutePath;
  /** Reports this level's part of the route. */
  report: (path: RoutePath) => void;
  /** True while this content is shown. */
  active: () => boolean;
  /** How many pages enclose this content; the deepest shown page names the
   * App's title. */
  depth: number;
};

const rootScope: ShellScope = {
  route: () => {
    const path = rootRoute().current();
    return path === '/' ? '' : path;
  },
  report: (path) => rootRoute().report(path),
  active: () => true,
  depth: 0,
};

export const ShellScopeContext = context<ShellScope>(rootScope);

type TitleClaim = { depth: number; order: number; title: () => string };

const claims = signal<readonly TitleClaim[]>([]);
let claimOrder = 0;
let sentTitle: string | undefined;

/**
 * Sends the title of the deepest shown page, latest first, whenever it
 * changes. `mount` runs it once, for the App's lifetime.
 */
export function followTitle(): void {
  effect(() => {
    let best: TitleClaim | undefined;
    for (const claim of claims()) {
      if (
        !best ||
        claim.depth > best.depth ||
        (claim.depth === best.depth && claim.order > best.order)
      )
        best = claim;
    }
    if (!best) return;
    const title = best.title();
    if (title === sentTitle) return;
    sentTitle = title;
    call('hatch.nav.setTitle', { title });
  });
}

/**
 * Names the App's title while `scope` is shown: call it in a component that
 * draws a screen's title. Among the shown claims the deepest wins, then the
 * one shown last.
 */
export function claimTitle(scope: ShellScope, title: () => string): void {
  effect(() => {
    if (!scope.active()) return;
    const claim: TitleClaim = {
      depth: scope.depth,
      order: (claimOrder += 1),
      title,
    };
    claims.set([...untracked(claims), claim]);
    return () => claims.set(untracked(claims).filter((item) => item !== claim));
  });
}
