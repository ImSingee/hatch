import { Scroll, Text, View, effect, untracked } from 'nsh';
import type { JSX } from 'nsh';
import { Tab, Tabs as BaseTabs } from 'nsh/base';
import { Each, If } from '../core/control';
import { SIDEBAR_MIN, paneWidth, touch } from '../core/env';
import { ShellScopeContext, firstSegment } from '../core/shell';
import type { RoutePath, ShellScope } from '../core/shell';
import { FOCUS_RING, FOCUS_RING_INSET } from '../core/styles';
import type { IconData } from '../core/types';
import { Glyph } from '../icons/Icon';
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

function Sidebar(props: AppShellProps & { selected: Selected }): JSX.Element {
  return (
    <View class="w-60 self-stretch border-r border-hairline bg-muted pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <View class="px-4 pb-2 pt-5">
        <Text class="text-control font-heading text-foreground truncate">
          {props.title}
        </Text>
      </View>
      <Scroll class="flex-1" contentClass="px-2.5 py-1">
        <BaseTabs
          accessibilityLabel="Sections"
          class="flex-col gap-0.5"
          indicatorClass="hidden"
        >
          <Each of={props.sections} key={(item) => item.id}>
            {(item) => (
              <Tab
                selected={props.selected.get() === item().id}
                disabled={item().disabled}
                onPress={() => props.selected.set(item().id)}
                accessibilityLabel={badgeLabel(item())}
                class={`group h-9 flex-row items-center gap-2.5 rounded-(--radius-md) px-2.5 disabled:opacity-50 pointer-coarse:h-11 ${FOCUS_RING}`}
                classList={{
                  'bg-primary-tint': props.selected.get() === item().id,
                  'hover:bg-surface-hover': props.selected.get() !== item().id,
                }}
              >
                <Glyph
                  icon={item().icon as IconData}
                  size="lg"
                  color={
                    props.selected.get() === item().id
                      ? 'primary-tint-foreground'
                      : 'muted-foreground'
                  }
                />
                <Text class="flex-1 truncate text-body font-label text-foreground group-selected:text-primary-tint-foreground">
                  {item().label}
                </Text>
                {item().badge ? (
                  <Text class="text-caption font-label text-muted-foreground group-selected:text-primary-tint-foreground">
                    {item().badge ?? ''}
                  </Text>
                ) : null}
              </Tab>
            )}
          </Each>
        </BaseTabs>
      </Scroll>
      {props.actions ? (
        <View class="flex-row flex-wrap gap-1 border-t border-hairline p-2.5">
          {props.actions}
        </View>
      ) : null}
    </View>
  );
}

function TopTabs(props: AppShellProps & { selected: Selected }): JSX.Element {
  return (
    <View class="flex-row items-center gap-2 border-b border-hairline bg-surface-window px-3 py-2">
      <Scroll horizontal scrollbar={false} class="flex-1">
        <BaseTabs
          accessibilityLabel="Sections"
          class="flex-row gap-1"
          indicatorClass="inset-y-0 rounded-(--radius-md) bg-card shadow-card"
        >
          <Each of={props.sections} key={(item) => item.id}>
            {(item) => (
              <Tab
                selected={props.selected.get() === item().id}
                disabled={item().disabled}
                onPress={() => props.selected.set(item().id)}
                accessibilityLabel={badgeLabel(item())}
                class={`group h-9 flex-row items-center gap-2 rounded-(--radius-md) px-3 disabled:opacity-50 ${FOCUS_RING}`}
                classList={{
                  'hover:bg-surface-hover': props.selected.get() !== item().id,
                }}
              >
                <Glyph
                  icon={item().icon as IconData}
                  size="md"
                  color={
                    props.selected.get() === item().id
                      ? 'foreground'
                      : 'muted-foreground'
                  }
                />
                <Text class="text-body font-label text-muted-foreground group-selected:text-foreground">
                  {item().label}
                </Text>
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
 * window. Each section's `content` is usually a `Page` or a `NavStack`.
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

  // The shell asked for another address: show the section it names, or the
  // starting one for the App's home.
  effect(() => {
    const id = sectionOf(scope.route());
    untracked(() => {
      const target = known(id) ? id : id === '' ? props.defaultValue : null;
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
  const panels = (
    <Panels
      items={props.sections}
      selected={selected.get}
      scope={sectionScope}
    />
  );
  return (
    <View
      class={`flex-1 self-stretch bg-surface-window ${layout() === 'sidebar' ? 'flex-row' : 'flex-col'}`}
    >
      {/* `If`, not ternaries: `layout()` reads the pane width, and a
          ternary would rebuild the navigation (losing its focus) on every
          resize instead of only when the layout changes. */}
      <If when={layout() === 'sidebar'}>
        <Sidebar {...props} selected={selected} />
      </If>
      <If when={layout() === 'top'}>
        <TopTabs {...props} selected={selected} />
      </If>
      <View class="flex-1 self-stretch">{panels}</View>
      <If when={layout() === 'bottom'}>
        <BottomBar {...props} selected={selected} />
      </If>
    </View>
  );
}
