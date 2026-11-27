import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import type { JSX } from 'nsh';
import { Tab, Tabs as BaseTabs } from 'nsh/base';
import { Each, If } from '../core/control';
import { SIDEBAR_MIN, byLook, look, paneWidth, touch } from '../core/env';
import { ShellScopeContext, firstSegment } from '../core/shell';
import type { RoutePath, ShellScope } from '../core/shell';
import { FOCUS_RING, FOCUS_RING_INSET } from '../core/styles';
import type { IconData } from '../core/types';
import { Glyph } from '../icons/Icon';
import type { GlyphColor, IconSize } from '../icons/Icon';
import {
  BottomChromeContext,
  SidebarToggleContext,
  bottomBarShown,
} from './nav-context';
import { Panels, selection } from './Tabs';
import type { TabItem } from './Tabs';

/** One top-level section of the App. */
export type AppSection = TabItem & {
  /** Sections show an icon in every layout. */
  icon: IconData;
  content: () => JSX.Element;
};

export type AppShellProps = {
  /** The App's name, shown above the sidebar. */
  title: string;
  /** Two to six top-level sections. */
  sections: readonly AppSection[];
  /** The selected section's id, when the App controls it. */
  value?: string;
  /** The section shown first, when the App does not control it and the
   * address names none. */
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Buttons at the foot of the sidebar, or at the end of the top tab row:
   * settings, account. */
  actions?: JSX.Element;
};

type Selected = ReturnType<typeof selection>;

function badgeLabel(item: TabItem): string {
  return item.badge ? `${item.label}, ${item.badge}` : item.label;
}

/**
 * The sidebar and the top tab row on the web and the desktops. The Desk's:
 * a muted column, the selected section tinted. macOS's: a source list on
 * the window's ground, 30-point rows, the selection a neutral fill with the icon in
 * the accent; the pages' title rows hold the button that hides it. Fluent's
 * navigation pane: on the window's own fill, 36-point rows, the selection
 * marked by an accent line, the content on a lighter layer with a rounded
 * corner. In a narrow pane the sections move to the top: the Desk's tab
 * row, macOS's segmented control in a toolbar, Fluent's top navigation.
 */
const WEB_SHELL: DeskShell = {
  root: 'bg-surface-window',
  sidebar:
    'w-60 self-stretch border-r border-hairline bg-muted pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]',
  header: 'px-4 pb-2 pt-5',
  title: 'text-control font-heading text-foreground truncate',
  list: 'px-2.5 py-1',
  rows: 'flex-col gap-0.5',
  row: `group h-9 flex-row items-center gap-2.5 rounded-(--radius-md) px-2.5 disabled:opacity-50 pointer-coarse:h-11 ${FOCUS_RING}`,
  rowSelected: 'bg-primary-tint',
  rowRest: 'hover:bg-surface-hover',
  rowGlyph: 'lg' as IconSize,
  rowGlyphSelected: 'primary-tint-foreground' as GlyphColor,
  rowText:
    'flex-1 truncate text-body font-label text-foreground group-selected:text-primary-tint-foreground',
  rowBadge:
    'text-caption font-label text-muted-foreground group-selected:text-primary-tint-foreground',
  marker: false,
  actions: 'flex-row flex-wrap gap-1 border-t border-hairline p-2.5',
  content: 'flex-1 self-stretch',
  topBar:
    'flex-row items-center gap-2 border-b border-hairline bg-surface-window px-3 py-2',
  topTabs: 'flex-row gap-1',
  topIndicator: 'inset-y-0 rounded-(--radius-md) bg-card shadow-card',
  topTab: `group h-9 flex-row items-center gap-2 rounded-(--radius-md) px-3 disabled:opacity-50 ${FOCUS_RING}`,
  topTabRest: 'hover:bg-surface-hover',
  topGlyph: 'md' as IconSize,
  topText:
    'text-body font-label text-muted-foreground group-selected:text-foreground',
  topContent: 'flex-1 self-stretch',
};

const SHELL = byLook<DeskShell>({
  web: WEB_SHELL,
  // iOS and Android keep the Desk's sidebar and top tabs on wide panes.
  ios: WEB_SHELL,
  android: WEB_SHELL,
  macos: {
    root: 'bg-background',
    sidebar: 'w-58 self-stretch border-r border-hairline bg-background',
    header: 'h-13 justify-center px-4',
    title: 'text-mac-body font-bold text-foreground truncate',
    list: 'px-2.5 pb-2',
    rows: 'flex-col gap-px',
    row: `group h-7.5 flex-row items-center gap-2.5 rounded-(--radius-xs) px-2.5 disabled:opacity-50 ${FOCUS_RING}`,
    rowSelected: 'bg-surface-pressed',
    rowRest: 'hover:bg-surface-hover',
    rowGlyph: 'md' as IconSize,
    rowGlyphSelected: 'primary-strong' as GlyphColor,
    rowText:
      'flex-1 truncate text-mac-body font-medium text-foreground group-selected:font-semibold',
    rowBadge: 'text-mac-callout font-medium text-muted-foreground',
    marker: false,
    actions: 'flex-row flex-wrap gap-1 border-t border-hairline p-2.5',
    content: 'flex-1 self-stretch bg-surface-window',
    topBar:
      'flex-row items-center justify-center gap-2 border-b border-hairline bg-background px-3 py-2.5',
    topTabs: 'flex-row gap-0.5 rounded-(--radius-xs) bg-surface-sunken p-0.5',
    topIndicator: 'inset-y-0.5 rounded-(--radius-xs) bg-card shadow-card',
    topTab: `group h-6 flex-row items-center gap-1.5 rounded-(--radius-xs) px-2.5 disabled:opacity-50 ${FOCUS_RING}`,
    topTabRest: 'active:bg-surface-pressed',
    topGlyph: 'sm' as IconSize,
    topText: 'text-mac-body font-medium text-foreground',
    topContent: 'flex-1 self-stretch bg-surface-window',
  },
  windows: {
    root: 'bg-background',
    sidebar: 'w-62 self-stretch bg-background',
    header: 'px-4 pb-2 pt-3',
    title: 'text-win-body font-semibold text-foreground truncate',
    list: 'px-2 pb-2',
    rows: 'flex-col gap-0.5',
    row: `group h-9 flex-row items-center gap-3 rounded-(--radius-xs) px-3 disabled:opacity-50 ${FOCUS_RING}`,
    rowSelected: 'bg-surface-hover',
    rowRest: 'hover:bg-surface-hover',
    rowGlyph: 'md' as IconSize,
    rowGlyphSelected: 'foreground' as GlyphColor,
    rowText:
      'flex-1 truncate text-win-label font-semibold text-foreground group-selected:font-bold',
    rowBadge: 'text-win-caption font-semibold text-muted-foreground',
    marker: true,
    actions: 'flex-row flex-wrap gap-1 border-t border-hairline p-2',
    content:
      'flex-1 self-stretch overflow-hidden rounded-tl-(--radius-sm) border-l border-t border-hairline bg-surface-window',
    topBar: 'flex-row items-center gap-2 bg-background px-2 py-1',
    topTabs: 'flex-row gap-1',
    topIndicator: 'bottom-0.5 h-0.75 rounded-full bg-primary',
    topTab: `group h-10 flex-row items-center gap-2 rounded-(--radius-xs) px-3 disabled:opacity-50 ${FOCUS_RING}`,
    topTabRest: 'hover:bg-surface-hover',
    topGlyph: 'md' as IconSize,
    topText:
      'text-win-label font-semibold text-muted-foreground group-selected:text-foreground',
    topContent:
      'flex-1 self-stretch border-t border-hairline bg-surface-window',
  },
});

type DeskShell = {
  root: string;
  sidebar: string;
  header: string;
  title: string;
  list: string;
  rows: string;
  row: string;
  rowSelected: string;
  rowRest: string;
  rowGlyph: IconSize;
  rowGlyphSelected: GlyphColor;
  rowText: string;
  rowBadge: string;
  /** Fluent's accent line at the start of the selected row. */
  marker: boolean;
  actions: string;
  content: string;
  topBar: string;
  topTabs: string;
  topIndicator: string;
  topTab: string;
  topTabRest: string;
  topGlyph: IconSize;
  topText: string;
  topContent: string;
};

function Sidebar(props: AppShellProps & { selected: Selected }): JSX.Element {
  return (
    <View class={SHELL.sidebar}>
      <View class={SHELL.header}>
        <Text class={SHELL.title}>{props.title}</Text>
      </View>
      <Scroll class="flex-1" contentClass={SHELL.list}>
        <BaseTabs
          accessibilityLabel="Sections"
          class={SHELL.rows}
          indicatorClass="hidden"
        >
          <Each of={props.sections} key={(item) => item.id}>
            {(item) => (
              <Tab
                selected={props.selected.get() === item().id}
                disabled={item().disabled}
                onPress={() => props.selected.set(item().id)}
                accessibilityLabel={badgeLabel(item())}
                class={SHELL.row}
                classList={{
                  [SHELL.rowSelected]: props.selected.get() === item().id,
                  [SHELL.rowRest]: props.selected.get() !== item().id,
                }}
              >
                {SHELL.marker ? (
                  <View class="pointer-events-none absolute inset-y-0 left-0 justify-center opacity-0 group-selected:opacity-100">
                    <View class="h-4 w-0.75 rounded-full bg-primary" />
                  </View>
                ) : null}
                <Glyph
                  icon={item().icon as IconData}
                  size={SHELL.rowGlyph}
                  color={
                    props.selected.get() === item().id
                      ? SHELL.rowGlyphSelected
                      : 'muted-foreground'
                  }
                />
                <Text class={SHELL.rowText}>{item().label}</Text>
                {item().badge ? (
                  <Text class={SHELL.rowBadge}>{item().badge ?? ''}</Text>
                ) : null}
              </Tab>
            )}
          </Each>
        </BaseTabs>
      </Scroll>
      {props.actions ? (
        <View class={SHELL.actions}>{props.actions}</View>
      ) : null}
    </View>
  );
}

function TopTabs(props: AppShellProps & { selected: Selected }): JSX.Element {
  return (
    <View class={SHELL.topBar}>
      <Scroll
        horizontal
        scrollbar={false}
        class={look === 'macos' ? 'shrink grow-0' : 'flex-1'}
      >
        <BaseTabs
          accessibilityLabel="Sections"
          class={SHELL.topTabs}
          indicatorClass={SHELL.topIndicator}
        >
          <Each of={props.sections} key={(item) => item.id}>
            {(item) => (
              <Tab
                selected={props.selected.get() === item().id}
                disabled={item().disabled}
                onPress={() => props.selected.set(item().id)}
                accessibilityLabel={badgeLabel(item())}
                class={SHELL.topTab}
                classList={{
                  [SHELL.topTabRest]: props.selected.get() !== item().id,
                }}
              >
                <Glyph
                  icon={item().icon as IconData}
                  size={SHELL.topGlyph}
                  color={
                    props.selected.get() === item().id
                      ? 'foreground'
                      : 'muted-foreground'
                  }
                />
                <Text class={SHELL.topText}>{item().label}</Text>
              </Tab>
            )}
          </Each>
        </BaseTabs>
      </Scroll>
      {props.actions ? (
        <View class="flex-row items-center gap-1">{props.actions}</View>
      ) : null}
    </View>
  );
}

function BottomBar(props: AppShellProps & { selected: Selected }): JSX.Element {
  return (
    <View class="border-t border-hairline bg-card pb-[env(safe-area-inset-bottom)]">
      <BaseTabs
        accessibilityLabel="Sections"
        class="flex-row px-1"
        indicatorClass="hidden"
      >
        <Each of={props.sections} key={(item) => item.id}>
          {(item) => (
            <Tab
              selected={props.selected.get() === item().id}
              disabled={item().disabled}
              onPress={() => props.selected.set(item().id)}
              accessibilityLabel={badgeLabel(item())}
              class={`group min-h-14 flex-1 items-center justify-center gap-0.5 py-1.5 disabled:opacity-50 ${FOCUS_RING_INSET}`}
            >
              <Glyph
                icon={item().icon as IconData}
                size="2xl"
                color={
                  props.selected.get() === item().id
                    ? 'primary-strong'
                    : 'muted-foreground'
                }
              />
              <Text class="text-eyebrow font-label text-muted-foreground group-selected:text-primary-strong truncate">
                {item().label}
              </Text>
            </Tab>
          )}
        </Each>
      </BaseTabs>
    </View>
  );
}

/**
 * iOS's tab bar: a floating, blurred capsule over the bottom of the
 * section, the selected tab on a tinted pill in the accent.
 */
function IosTabBar(props: AppShellProps & { selected: Selected }): JSX.Element {
  return (
    <View class="absolute inset-x-5 bottom-0 mb-2 pb-[env(safe-area-inset-bottom)]">
      <View class="h-16 flex-row items-center rounded-full border border-hairline bg-surface-dock px-1.5 shadow-dock backdrop-blur-xl">
        <BaseTabs
          accessibilityLabel="Sections"
          class="flex-1 flex-row"
          indicatorClass="hidden"
        >
          <Each of={props.sections} key={(item) => item.id}>
            {(item) => (
              <Tab
                selected={props.selected.get() === item().id}
                disabled={item().disabled}
                onPress={() => props.selected.set(item().id)}
                accessibilityLabel={badgeLabel(item())}
                class={`group h-13 flex-1 items-center justify-center gap-0.5 rounded-full px-1 active:opacity-60 disabled:opacity-40 selected:bg-surface-hover ${FOCUS_RING_INSET}`}
              >
                <Glyph
                  icon={item().icon as IconData}
                  size="2xl"
                  color={
                    props.selected.get() === item().id
                      ? 'primary-strong'
                      : 'muted-foreground'
                  }
                />
                <Text class="text-ios-caption-2 font-semibold text-muted-foreground group-selected:text-primary-strong truncate">
                  {item().label}
                </Text>
              </Tab>
            )}
          </Each>
        </BaseTabs>
      </View>
    </View>
  );
}

/**
 * Material 3's navigation bar: 80 points, the selected destination's icon
 * on a 64 by 32 tinted pill.
 */
function AndroidNavigationBar(
  props: AppShellProps & { selected: Selected },
): JSX.Element {
  return (
    <View class="bg-muted pb-[env(safe-area-inset-bottom)]">
      <BaseTabs
        accessibilityLabel="Sections"
        class="h-20 flex-row"
        indicatorClass="hidden"
      >
        <Each of={props.sections} key={(item) => item.id}>
          {(item) => (
            <Tab
              selected={props.selected.get() === item().id}
              disabled={item().disabled}
              onPress={() => props.selected.set(item().id)}
              accessibilityLabel={badgeLabel(item())}
              class={`group flex-1 items-center gap-1 pb-4 pt-3 disabled:opacity-40 ${FOCUS_RING_INSET}`}
            >
              <View class="h-8 w-16 items-center justify-center rounded-full transition-colors group-active:bg-surface-pressed group-selected:bg-primary-tint">
                <Glyph
                  icon={item().icon as IconData}
                  size="2xl"
                  color={
                    props.selected.get() === item().id
                      ? 'primary-tint-foreground'
                      : 'muted-foreground'
                  }
                />
              </View>
              <Text class="text-m3-label-md font-medium text-muted-foreground group-selected:font-bold group-selected:text-foreground truncate">
                {item().label}
              </Text>
            </Tab>
          )}
        </Each>
      </BaseTabs>
    </View>
  );
}

/** The section id an address names: its first segment, decoded. */
function sectionOf(path: RoutePath): string {
  const [segment] = firstSegment(path);
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

/**
 * The frame of an App with top-level sections. It decides the navigation
 * from the App's own pane: a sidebar when the pane is wide, a bottom tab bar
 * on narrow touch screens, a row of tabs at the top in a narrow desktop
 * window. On macOS people can hide the sidebar. Each section's `content` is
 * usually a `Page` or a `NavStack`.
 *
 * The selected section is the first segment of the App's address
 * (`/<section id>`, then the section's `NavStack` path), so a deep link or a
 * reload opens the same section and the shell can navigate between them.
 */
export function AppShell(props: AppShellProps): JSX.Element {
  const scope = ShellScopeContext();
  const known = (id: string) =>
    props.sections.some((section) => section.id === id && !section.disabled);
  const opened = sectionOf(untracked(scope.route));
  const selected = selection({
    get items() {
      return props.sections;
    },
    get value() {
      return props.value;
    },
    defaultValue: untracked(() => known(opened)) ? opened : props.defaultValue,
    onChange: (id) => props.onChange?.(id),
  });

  // Each section's own part of the address, remembered while it is hidden so
  // switching back restores its pages' address too.
  const subPaths = new Map<string, RoutePath>();
  const sectionPath = (id: string) =>
    `/${encodeURIComponent(id)}${subPaths.get(id) ?? ''}`;
  const sectionScope = (id: string, shown: () => boolean): ShellScope => ({
    route: () => {
      const path = scope.route();
      const [segment, rest] = firstSegment(path);
      if (segment === '' || sectionOf(path) !== id)
        return subPaths.get(id) ?? '';
      subPaths.set(id, rest);
      return rest;
    },
    report: (path) => {
      subPaths.set(id, path);
      if (untracked(selected.get) === id) scope.report(sectionPath(id));
    },
    active: () => scope.active() && shown(),
    depth: scope.depth,
  });

  // The shell asked for another address: show the section it names, or for
  // the App's home the one it starts on (`defaultValue`, else the first
  // enabled section), as opening the App there would.
  const home = () =>
    props.defaultValue !== undefined && known(props.defaultValue)
      ? props.defaultValue
      : props.sections.find((section) => !section.disabled)?.id;
  effect(() => {
    const id = sectionOf(scope.route());
    untracked(() => {
      const target = known(id) ? id : id === '' ? home() : undefined;
      if (target && target !== selected.get()) selected.set(target);
    });
  });
  // The selected section is the address.
  effect(() => {
    const id = selected.get();
    if (id === '' || !scope.active()) return;
    untracked(() => {
      if (sectionOf(scope.route()) !== id) scope.report(sectionPath(id));
    });
  });
  const layout = (): 'sidebar' | 'bottom' | 'top' => {
    if (paneWidth() >= SIDEBAR_MIN) return 'sidebar';
    return touch ? 'bottom' : 'top';
  };
  // Toasts rise above the bottom bar while it shows.
  effect(() => {
    const shown = layout() === 'bottom';
    bottomBarShown.set(shown);
    return () => bottomBarShown.set(false);
  });
  if (look === 'ios') {
    // The tab bar floats over the section: pages scroll their content
    // clear of it.
    return (
      <View
        class={`flex-1 self-stretch bg-surface-window ${layout() === 'sidebar' ? 'flex-row' : 'flex-col'}`}
      >
        <If when={layout() === 'sidebar'}>
          <Sidebar {...props} selected={selected} />
        </If>
        <If when={layout() === 'top'}>
          <TopTabs {...props} selected={selected} />
        </If>
        <View class="flex-1 self-stretch">
          {/* The panels are made here, inside the provider: their pages read
              the context when they are created. */}
          <BottomChromeContext.Provider
            value={() => (layout() === 'bottom' ? 'h-20' : '')}
          >
            <Panels
              items={props.sections}
              selected={selected.get}
              scope={sectionScope}
            />
          </BottomChromeContext.Provider>
        </View>
        <If when={layout() === 'bottom'}>
          <IosTabBar {...props} selected={selected} />
        </If>
      </View>
    );
  }
  // macOS lets people hide the sidebar; the pages' title rows hold the
  // button (`SidebarToggleContext`).
  const sidebarShown = signal(true);
  const panels =
    look === 'macos' ? (
      <SidebarToggleContext.Provider
        value={{
          available: () => layout() === 'sidebar',
          shown: sidebarShown,
          toggle: () => sidebarShown.set(!untracked(sidebarShown)),
        }}
      >
        <Panels
          items={props.sections}
          selected={selected.get}
          scope={sectionScope}
        />
      </SidebarToggleContext.Provider>
    ) : (
      <Panels
        items={props.sections}
        selected={selected.get}
        scope={sectionScope}
      />
    );
  return (
    <View
      class={`flex-1 self-stretch ${SHELL.root} ${layout() === 'sidebar' ? 'flex-row' : 'flex-col'}`}
    >
      {/* `If`, not ternaries: `layout()` reads the pane width, and a
          ternary would rebuild the navigation (losing its focus) on every
          resize instead of only when the layout changes. */}
      <If when={layout() === 'sidebar' && sidebarShown()}>
        <Sidebar {...props} selected={selected} />
      </If>
      <If when={layout() === 'top'}>
        <TopTabs {...props} selected={selected} />
      </If>
      <View class={layout() === 'top' ? SHELL.topContent : SHELL.content}>
        {panels}
      </View>
      <If when={layout() === 'bottom'}>
        {look === 'android' ? (
          <AndroidNavigationBar {...props} selected={selected} />
        ) : (
          <BottomBar {...props} selected={selected} />
        )}
      </If>
    </View>
  );
}
