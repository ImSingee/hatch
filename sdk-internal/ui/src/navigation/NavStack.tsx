import { effect, untracked } from 'nsh';
import type { JSX } from 'nsh';
import {
  NavPage,
  NavStack as BaseNavStack,
  createNavStack as createBaseNavStack,
} from 'nsh/base';
import type { NavStackState } from 'nsh/base';
import { ShellScopeContext, normalizeRoute } from '../core/shell';
import type { RoutePath } from '../core/shell';
import { PageNavContext } from './nav-context';

export type { NavStackState };

/**
 * The state of a `NavStack`: its routes, with `push`, `pop`, `popToRoot`,
 * `replace` and `setRoutes`. Make it once, outside components, with the
 * first route: `const nav = createNavStack<Route>([{ name: 'list' }])`.
 */
export function createNavStack<R>(routes: R[]): NavStackState<R> {
  return createBaseNavStack(routes);
}

/**
 * How a stack's pages map to the App's address, so a deep link, a reload or
 * the shell's back button shows the same pages.
 */
export type NavRoutes<R> = {
  /** The address of a stack, from its first page to the top one:
   * `''` for the first page alone, `/notes/42` for a note pushed on it. */
  path: (stack: readonly R[]) => string;
  /** The stack an address shows, first page included, or `null` for an
   * address the App does not know (the first page is shown). */
  parse: (path: string) => R[] | null;
};

export type NavStackProps<R> = {
  /** From `createNavStack`. */
  stack: NavStackState<R>;
  /** The page of a route: a `Page`, or a page pattern. */
  children: (route: R) => JSX.Element;
  /** Keeps the stack in the App's address (deep links, reloads, the
   * shell's back button). Without it the address names only the section. */
  routes?: NavRoutes<R>;
};

/** `''` or a path starting with `/`. */
function stackPath(path: string): RoutePath {
  const normalized = normalizeRoute(path);
  return normalized === '/' ? '' : normalized;
}

/**
 * Pages pushed on top of each other, with the platform's back gestures and
 * keys. Each page above the first gets a back button in its title row. Only
 * the top page counts as shown: it names the App's title.
 */
export function NavStack<R>(props: NavStackProps<R>): JSX.Element {
  const scope = ShellScopeContext();
  const first = untracked(props.stack.routes).slice(0, 1);

  /** The stack for `path`, keeping the pages that stay the same. */
  const stackFor = (routes: NavRoutes<R>, path: RoutePath): R[] => {
    const target = (path === '' ? null : routes.parse(path)) ?? first;
    const current = untracked(props.stack.routes);
    return target.map((route, index) => {
      const kept = current[index];
      return kept !== undefined &&
        stackPath(routes.path(current.slice(0, index + 1))) ===
          stackPath(routes.path(target.slice(0, index + 1)))
        ? kept
        : route;
    });
  };

  // What this stack last showed or reported, so its own reports do not come
  // back to it as navigations.
  let shown: RoutePath | undefined;
  effect(() => {
    const routes = props.routes;
    if (!routes) return;
    const path = stackPath(scope.route());
    if (path === shown) return;
    shown = path;
    const next = stackFor(routes, path);
    const current = untracked(props.stack.routes);
    if (
      next.length !== current.length ||
      next.some((route, index) => route !== current[index])
    )
      props.stack.setRoutes(next);
  });
  effect(() => {
    const routes = props.routes;
    if (!routes) return;
    const path = stackPath(routes.path(props.stack.routes()));
    if (!scope.active() || path === untracked(() => shown)) return;
    shown = path;
    scope.report(path);
  });

  return (
    <BaseNavStack state={props.stack} class="flex-1 self-stretch">
      {(route, index) => (
        <NavPage headerVisible={false} class="flex-1 bg-surface-window">
          <ShellScopeContext.Provider
            value={{
              ...scope,
              active: () =>
                scope.active() && index() === props.stack.routes().length - 1,
            }}
          >
            <PageNavContext.Provider
              value={{
                canGoBack: () => index() > 0,
                back: () => props.stack.pop(),
              }}
            >
              {props.children(route)}
            </PageNavContext.Provider>
          </ShellScopeContext.Provider>
        </NavPage>
      )}
    </BaseNavStack>
  );
}
