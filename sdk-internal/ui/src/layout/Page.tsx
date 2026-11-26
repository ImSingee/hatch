import { Scroll, Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { ShellScopeContext, claimTitle } from '../core/shell';
import { GAP } from '../core/styles';
import { HeadingText } from '../display/Text';
import type { Space } from '../core/types';
import { IconChevronLeft } from '../icons/icons.gen';
import { IconButton } from '../input/Button';
import { PageNavContext } from '../navigation/nav-context';

export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

export type PageProps = {
  /** The page's title, in sentence case. */
  title: string;
  /** One sentence under the title. */
  description?: string;
  /** Buttons at the end of the title row: at most one primary. */
  actions?: JSX.Element;
  children?: JSX.Element;
  /** The widest the content gets: `narrow` 672 points for forms and
   * settings, `default` 1024, `wide` 1280, `full` the pane. */
  width?: PageWidth;
  /** Space between the page's children; default `xl` (24 points). */
  gap?: Space;
  /** Hides the title row: for a page whose content starts with its own
   * heading, such as an empty state. Screen readers still read the title. */
  hideTitle?: boolean;
};

const WIDTH: Record<PageWidth, string> = {
  narrow: 'max-w-2xl',
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

/**
 * One screen of the App: a scrolling body with the title row. In a
 * `NavStack` above its first page, the title row starts with a back button.
 * While it is shown (the selected section, the top of its stack) its title
 * is the App's title in the shell; the deepest shown page wins.
 */
export function Page(props: PageProps): JSX.Element {
  const nav = PageNavContext();
  const scope = ShellScopeContext();
  const own = { ...scope, depth: scope.depth + 1 };
  claimTitle(own, () => props.title);
  return (
    <ShellScopeContext.Provider value={own}>
      <Scroll
        class="flex-1 self-stretch bg-surface-window"
        contentClass="grow pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        accessibilityLabel={props.title}
      >
        <View
          class={[
            'w-full self-center px-4 py-5 sm:px-6 sm:py-6 lg:px-8',
            WIDTH[props.width ?? 'default'],
            GAP[props.gap ?? 'xl'],
          ].join(' ')}
        >
          {props.hideTitle ? null : (
            <View class="flex-row flex-wrap items-start gap-3">
              {nav?.canGoBack() ? (
                <View class="-ml-2 pointer-coarse:-ml-3">
                  <IconButton
                    icon={IconChevronLeft}
                    label="Back"
                    onPress={nav.back}
                  />
                </View>
              ) : null}
              <View class="min-w-48 flex-1 gap-1">
                <HeadingText
                  level={1}
                  class="text-section sm:text-title text-foreground text-balance"
                >
                  {props.title}
                </HeadingText>
                {props.description ? (
                  <Text class="text-body text-muted-foreground text-pretty">
                    {props.description}
                  </Text>
                ) : null}
              </View>
              {props.actions ? (
                <View class="flex-row flex-wrap items-center gap-2">
                  {props.actions}
                </View>
              ) : null}
            </View>
          )}
          {props.children}
        </View>
      </Scroll>
    </ShellScopeContext.Provider>
  );
}
