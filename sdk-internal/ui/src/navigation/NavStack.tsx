import type { JSX } from 'nsh';
import {
  NavPage,
  NavStack as BaseNavStack,
  createNavStack as createBaseNavStack,
} from 'nsh/base';
import type { NavStackState } from 'nsh/base';
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

export type NavStackProps<R> = {
  /** From `createNavStack`. */
  stack: NavStackState<R>;
  /** The page of a route: a `Page`, or a page pattern. */
  children: (route: R) => JSX.Element;
};

/**
 * Pages pushed on top of each other, with the platform's back gestures and
 * keys. Each page above the first gets a back button in its title row.
 */
export function NavStack<R>(props: NavStackProps<R>): JSX.Element {
  return (
    <BaseNavStack state={props.stack} class="flex-1 self-stretch">
      {(route, index) => (
        <NavPage headerVisible={false} class="flex-1 bg-surface-window">
          <PageNavContext.Provider
            value={{
              canGoBack: () => index() > 0,
              back: () => props.stack.pop(),
            }}
          >
            {props.children(route)}
          </PageNavContext.Provider>
        </NavPage>
      )}
    </BaseNavStack>
  );
}
