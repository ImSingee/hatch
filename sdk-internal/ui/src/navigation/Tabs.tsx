import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import type { JSX } from 'nsh';
import { Tab, Tabs as BaseTabs } from 'nsh/base';
import { Each, If } from '../core/control';
import { FOCUS_RING } from '../core/styles';
import type { IconData } from '../core/types';
import { Glyph } from '../icons/Icon';

/** One tab of `Tabs` or one section of `AppShell`. */
export type TabItem = {
  /** Stable id: the value `onChange` reports. */
  id: string;
  label: string;
  icon?: IconData;
  /** A short count or word beside the label, such as unread items. */
  badge?: string;
  disabled?: boolean;
  /** What the tab shows. A visited tab stays mounted while hidden, so its
   * scroll position and input survive switching back. */
  content?: () => JSX.Element;
};

/** The selected id: the App's, else the one the user chose (at first
 * `defaultValue`) while it is an enabled item, else the first enabled item,
 * which then stays selected while the items change around it. So items that
 * arrive later, or the removal or disabling of the selected one, never leave
 * the content area empty. With no enabled item, a selected item that still
 * exists stays shown. */
export function selection(props: {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
}): { get: () => string; set: (id: string) => void } {
  const own = signal(props.defaultValue);
  const uncontrolled = (): string => {
    const chosen = own();
    const enabled = props.items.filter((item) => !item.disabled);
    if (enabled.some((item) => item.id === chosen)) return chosen as string;
    if (enabled[0]) return enabled[0].id;
    return props.items.some((item) => item.id === chosen)
      ? (chosen as string)
      : '';
  };
  // Remember a fallback once it is shown, so items added before it later do
  // not move the selection.
  effect(() => {
    if (props.value !== undefined) return;
    const shown = uncontrolled();
    if (shown !== '' && shown !== untracked(own)) own.set(shown);
  });
  return {
    get: () => props.value ?? uncontrolled(),
    set: (id) => {
      own.set(id);
      props.onChange?.(id);
    },
  };
}

/**
 * The panels of the items with `content`: each mounts the first time it is
 * selected and stays mounted, hidden while another is selected.
 */
export function Panels(props: {
  items: readonly TabItem[];
  selected: () => string;
}): JSX.Element {
  const visited = signal<ReadonlySet<string>>(new Set([props.selected()]));
  effect(() => {
    const id = props.selected();
    if (!untracked(visited).has(id))
      visited.set(new Set([...untracked(visited), id]));
  });
  return (
    <Each of={props.items} key={(item) => item.id}>
      {(item) => {
        const shown = () => props.selected() === item().id;
        return (
          <If
            when={
              item().content !== undefined &&
              (shown() || visited().has(item().id))
            }
          >
            <View
              class="flex-1 self-stretch"
              // `invisible` as well: NSH's web runtime lays a hidden view
              // out at zero size but leaves it in the focus order.
              classList={{ hidden: !shown(), invisible: !shown() }}
              accessibilityElementsHidden={!shown()}
            >
              {item().content?.()}
            </View>
          </If>
        );
      }}
    </Each>
  );
}

export type TabsProps = {
  /** What the tabs choose between, for screen readers: "Views", "Period". */
  label: string;
  items: readonly TabItem[];
  /** The selected id, when the App controls it. */
  value?: string;
  /** The id selected at first, when the App does not control it. */
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Stretches the tabs across the width, each the same size. */
  fullWidth?: boolean;
};

/**
 * A segmented control that switches between views of the same content. With
 * `content` on its items it also shows the selected view.
 */
export function Tabs(props: TabsProps): JSX.Element {
  const selected = selection(props);
  const list = (
    <BaseTabs
      accessibilityLabel={props.label}
      class={`flex-row gap-0.5 rounded-(--radius-md) bg-surface-sunken p-0.5 ${props.fullWidth ? 'self-stretch' : 'self-start'}`}
      indicatorClass="inset-y-0.5 rounded-(--radius-sm) bg-card shadow-card"
    >
      <Each of={props.items} key={(item) => item.id}>
        {(item) => (
          <Tab
            selected={selected.get() === item().id}
            disabled={item().disabled}
            onPress={() => selected.set(item().id)}
            accessibilityLabel={
              item().badge ? `${item().label}, ${item().badge}` : item().label
            }
            class={`group h-8 flex-row items-center justify-center gap-1.5 rounded-(--radius-sm) px-3 disabled:opacity-50 pointer-coarse:h-10 ${FOCUS_RING} ${props.fullWidth ? 'flex-1' : ''}`}
          >
            {item().icon ? (
              <Glyph
                icon={item().icon as IconData}
                size="sm"
                color={
                  selected.get() === item().id
                    ? 'foreground'
                    : 'muted-foreground'
                }
              />
            ) : null}
            <Text class="text-body font-label text-muted-foreground group-selected:text-foreground">
              {item().label}
            </Text>
            {item().badge ? (
              <Text class="rounded-full bg-surface-hover px-1.5 text-caption font-label text-neutral-strong">
                {item().badge ?? ''}
              </Text>
            ) : null}
          </Tab>
        )}
      </Each>
    </BaseTabs>
  );
  const hasPanels = () => props.items.some((item) => item.content);
  return (
    <View class="self-stretch gap-4" classList={{ 'flex-1': hasPanels() }}>
      {props.fullWidth ? (
        list
      ) : (
        <Scroll horizontal scrollbar={false} class="self-stretch grow-0">
          {list}
        </Scroll>
      )}
      {hasPanels() ? (
        <Panels items={props.items} selected={selected.get} />
      ) : null}
    </View>
  );
}
