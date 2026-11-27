import { Scroll, Text, View, effect } from 'nsh';
import type { JSX } from 'nsh';
import { Button as BaseButton } from 'nsh/base';
import { look } from '../core/env';
import { BarActionsContext } from '../core/overlay';
import { SurfaceContext } from '../core/surface';
import { ShellScopeContext, claimTitle } from '../core/shell';
import { FOCUS_RING, GAP } from '../core/styles';
import { HeadingText } from '../display/Text';
import type { Space } from '../core/types';
import { Glyph } from '../icons/Icon';
import { IconArrowLeft, IconChevronLeft } from '../icons/icons.gen';
import { IconButton } from '../input/Button';
import { BottomChromeContext, PageNavContext } from '../navigation/nav-context';
import type { PageNav } from '../navigation/nav-context';

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
 *
 * On iOS the first page of a stack shows a large title that scrolls with
 * the content, and a page above it a navigation bar: back with the title of
 * the page it leads to, the title in the middle, the actions at the end. On
 * Android every page has a top app bar.
 */
export function Page(props: PageProps): JSX.Element {
  const nav = PageNavContext();
  const scope = ShellScopeContext();
  const own = { ...scope, depth: scope.depth + 1 };
  claimTitle(own, () => props.title);
  if (look !== 'web') {
    effect(() => nav?.nameTitle?.(() => props.title));
    return (
      <ShellScopeContext.Provider value={own}>
        <SurfaceContext.Provider value="background">
          {look === 'ios' ? (
            <IosPage {...props} nav={nav} />
          ) : (
            <AndroidPage {...props} nav={nav} />
          )}
        </SurfaceContext.Provider>
      </ShellScopeContext.Provider>
    );
  }
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

type PlatformPageProps = PageProps & { nav: PageNav | null };

/** The scrolling body of a platform page, clear of the bottom chrome. */
function PlatformBody(props: {
  page: PageProps;
  children?: JSX.Element;
}): JSX.Element {
  const bottom = BottomChromeContext();
  return (
    <Scroll
      class="flex-1 self-stretch"
      contentClass="grow pb-[env(safe-area-inset-bottom)]"
      accessibilityLabel={props.page.title}
    >
      <View
        class={[
          'w-full self-center px-5 pb-5 sm:px-6 lg:px-8',
          WIDTH[props.page.width ?? 'default'],
          GAP[props.page.gap ?? 'xl'],
        ].join(' ')}
      >
        {props.children}
      </View>
      <View class={bottom()} />
    </Scroll>
  );
}

/** The actions at the end of a platform page's bar. */
function BarActions(props: { children?: JSX.Element }): JSX.Element {
  return (
    <BarActionsContext.Provider value>
      <View class="flex-row items-center gap-1">{props.children}</View>
    </BarActionsContext.Provider>
  );
}

/** iOS's back button: a chevron and the title of the page it leads to. */
function IosBack(props: { nav: PageNav }): JSX.Element {
  const label = () => props.nav.backLabel?.() ?? 'Back';
  return (
    <BaseButton
      onPress={props.nav.back}
      // The same name as on every look; the title it shows is the hint.
      accessibilityLabel="Back"
      accessibilityHint={label()}
      class={`h-11 max-w-36 flex-row items-center gap-0.5 rounded-(--radius-md) pr-2 active:opacity-50 ${FOCUS_RING}`}
    >
      <Glyph icon={IconChevronLeft} size="2xl" color="primary-strong" />
      <Text class="shrink truncate text-ios-body font-regular text-primary-strong">
        {label()}
      </Text>
    </BaseButton>
  );
}

function IosPage(props: PlatformPageProps): JSX.Element {
  const pushed = () => props.nav?.canGoBack() === true;
  const bar = () => pushed() || props.actions !== undefined;
  return (
    <View class="flex-1 self-stretch bg-background">
      {bar() ? (
        <View class="pt-[env(safe-area-inset-top)]">
          <View class="h-11 flex-row items-center px-2">
            {pushed() && props.nav ? <IosBack nav={props.nav} /> : null}
            {pushed() && !props.hideTitle ? (
              <View class="absolute inset-y-0 left-24 right-24 items-center justify-center">
                <HeadingText
                  level={1}
                  class="truncate text-ios-body font-semibold tracking-normal text-foreground"
                >
                  {props.title}
                </HeadingText>
              </View>
            ) : null}
            <View class="flex-1" />
            {props.actions ? <BarActions>{props.actions}</BarActions> : null}
          </View>
        </View>
      ) : (
        <View class="pt-[env(safe-area-inset-top)]" />
      )}
      <PlatformBody page={props}>
        {pushed() || props.hideTitle ? null : (
          <View class={`gap-1 ${bar() ? '' : 'pt-3'}`}>
            <HeadingText
              level={1}
              class="text-ios-large-title font-bold text-foreground text-balance"
            >
              {props.title}
            </HeadingText>
            {props.description ? (
              <Text class="text-ios-subhead font-regular text-muted-foreground text-pretty">
                {props.description}
              </Text>
            ) : null}
          </View>
        )}
        {pushed() && props.description ? (
          <Text class="pt-2 text-ios-subhead font-regular text-muted-foreground text-pretty">
            {props.description}
          </Text>
        ) : null}
        {props.children}
      </PlatformBody>
    </View>
  );
}

function AndroidPage(props: PlatformPageProps): JSX.Element {
  const pushed = () => props.nav?.canGoBack() === true;
  return (
    <View class="flex-1 self-stretch bg-background">
      <View class="pt-[env(safe-area-inset-top)]">
        <View
          class={`h-16 flex-row items-center gap-1 pr-3 ${pushed() ? 'pl-1' : 'pl-5'}`}
        >
          {pushed() && props.nav ? (
            <IconButton
              icon={IconArrowLeft}
              label="Back"
              onPress={props.nav.back}
            />
          ) : null}
          <View class="flex-1">
            {props.hideTitle ? null : (
              <HeadingText
                level={1}
                class="truncate text-m3-title-lg font-medium tracking-normal text-foreground"
              >
                {props.title}
              </HeadingText>
            )}
          </View>
          {props.actions ? <BarActions>{props.actions}</BarActions> : null}
        </View>
      </View>
      <PlatformBody page={props}>
        {props.description ? (
          <Text class="text-m3-body-md font-regular text-muted-foreground text-pretty">
            {props.description}
          </Text>
        ) : null}
        {props.children}
      </PlatformBody>
    </View>
  );
}
