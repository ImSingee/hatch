import { Scroll, Text, View } from 'nsh';
import type { JSX } from 'nsh';
import { Tab, Tabs as BaseTabs } from 'nsh/base';
import { Each } from '../core/control';
import { SIDEBAR_MIN, paneWidth, touch } from '../core/env';
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
  /** The section shown first, when the App does not control it. */
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

/**
 * The frame of an App with top-level sections. It decides the navigation
 * from the App's own pane: a sidebar when the pane is wide, a bottom tab bar
 * on narrow touch screens, a row of tabs at the top in a narrow desktop
 * window. Each section's `content` is usually a `Page` or a `NavStack`.
 */
export function AppShell(props: AppShellProps): JSX.Element {
  const selected = selection({
    get items() {
      return props.sections;
    },
    get value() {
      return props.value;
    },
    get defaultValue() {
      return props.defaultValue;
    },
    onChange: (id) => props.onChange?.(id),
  });
  const layout = (): 'sidebar' | 'bottom' | 'top' => {
    if (paneWidth() >= SIDEBAR_MIN) return 'sidebar';
    return touch ? 'bottom' : 'top';
  };
  const panels = <Panels items={props.sections} selected={selected.get} />;
  return (
    <View
      class={`flex-1 self-stretch bg-surface-window ${layout() === 'sidebar' ? 'flex-row' : 'flex-col'}`}
    >
      {layout() === 'sidebar' ? (
        <Sidebar {...props} selected={selected} />
      ) : null}
      {layout() === 'top' ? <TopTabs {...props} selected={selected} /> : null}
      <View class="flex-1 self-stretch">{panels}</View>
      {layout() === 'bottom' ? (
        <BottomBar {...props} selected={selected} />
      ) : null}
    </View>
  );
}
