import { Overlay, Text, View, signal } from 'nsh';
import type { JSX } from 'nsh';
import {
  Toast as BaseToast,
  ToastManager,
  ToastStack,
  type ToastEntry,
} from 'nsh/base';
import { Each } from '../core/control';
import { byLook, look, paneSize } from '../core/env';
import { FOCUS_RING } from '../core/styles';
import { bottomBarShown } from '../navigation/nav-context';
import type { Action } from '../core/types';
import { Glyph } from '../icons/Icon';
import type { GlyphColor } from '../icons/Icon';
import type { IconData } from '../icons/icon-data';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
} from '../icons/icons.gen';
import { Button as BaseButton } from 'nsh/base';
import { Button } from '../input/Button';

/** `neutral` for confirmations ("Copied"), the others for outcomes. */
export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export type ToastOptions = {
  /** A short sentence: what happened. */
  title: string;
  /** More detail, one sentence. */
  description?: string;
  tone?: ToastTone;
  /** One action, such as Undo. Pressing it also dismisses the toast. */
  action?: Action;
  /** Seconds the toast stays; default 5, 8 with an action. */
  duration?: number;
};

/** What the manager keeps: plain data only. NSH stores a toast's value as
 * JSON, so a function in it (an action's `onPress`) would be dropped. */
type Shown = Required<Pick<ToastOptions, 'title' | 'tone'>> &
  Pick<ToastOptions, 'description'> & {
    action?: { label: string; disabled?: boolean };
  };

const TONE_ICON: Record<ToastTone, IconData | null> = {
  neutral: null,
  success: IconCircleCheck,
  warning: IconAlertTriangle,
  danger: IconCircleX,
  info: IconInfoCircle,
};

const TONE_COLOR: Record<ToastTone, GlyphColor> = {
  neutral: 'foreground',
  success: 'success-strong',
  warning: 'warning-strong',
  danger: 'danger-strong',
  info: 'info-strong',
};

/**
 * A toast on each look: the Desk's card; on iOS a borderless card; on
 * Android Material's snackbar, inverse colours and its action as text.
 */
const CARD = byLook({
  web: {
    card: 'flex-row items-start gap-3 rounded-(--radius-lg) border border-hairline bg-popover px-4 py-3 shadow-dock transition-all duration-200',
    title: 'text-body font-label text-popover-foreground',
    description: 'text-caption text-muted-foreground',
  },
  ios: {
    card: 'flex-row items-center gap-3 rounded-(--radius-lg) bg-popover px-4 py-3 shadow-window transition-all duration-200',
    title: 'text-ios-subhead font-semibold text-popover-foreground',
    description: 'text-ios-footnote font-regular text-muted-foreground',
  },
  android: {
    card: 'min-h-12 flex-row items-center gap-3 rounded-(--radius-xs) bg-foreground px-4 py-3 shadow-dock transition-all duration-200',
    title: 'text-m3-body-md font-regular text-background',
    description: 'text-m3-body-md font-regular text-background',
  },
});

const VISIBLE = 3;
const TICK_MS = 50;

const manager = new ToastManager();
const shown = signal<ToastEntry[]>([]);
const expanded = signal(false);
let timer: number | undefined;
let nextId = 0;
/** Each shown toast's action, by toast id, until the toast is removed. */
const actions = new Map<string, () => void>();

function sync(): void {
  shown.set(manager.visible(VISIBLE));
  if (manager.isEmpty() && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function tick(): void {
  const step = manager.advance(expanded());
  for (const entry of step.removed) actions.delete(entry.id);
  if (step.changed) sync();
}

function dismiss(id: string): void {
  manager.dismiss(id);
  sync();
}

/** Runs a toast's action, then dismisses the toast. */
function runAction(id: string): void {
  const action = actions.get(id);
  actions.delete(id);
  action?.();
  dismiss(id);
}

function show(options: ToastOptions): string {
  nextId += 1;
  const id = `toast-${nextId}`;
  const value: Shown = {
    title: options.title,
    description: options.description,
    tone: options.tone ?? 'neutral',
    action: options.action
      ? { label: options.action.label, disabled: options.action.disabled }
      : undefined,
  };
  if (options.action) actions.set(id, options.action.onPress);
  const seconds = options.duration ?? (options.action ? 8 : 5);
  manager.push(id, value, { timeout: seconds * 1000 });
  timer ??= setInterval(tick, TICK_MS);
  sync();
  return id;
}

/**
 * Short messages over the App that go away on their own: "Saved", "Could not
 * send · Try again". Call from anywhere after `mount`.
 */
export const Toast = {
  /** Shows a toast; returns its id. */
  show,
  /** Shows a success toast. */
  success: (title: string, description?: string): string =>
    show({ title, description, tone: 'success' }),
  /** Shows a toast for a failure. */
  error: (title: string, description?: string): string =>
    show({ title, description, tone: 'danger' }),
  /** Removes a toast before its time is up. */
  dismiss,
};

function ToastCard(props: { entry: () => ToastEntry }): JSX.Element {
  const value = () => props.entry().value as Shown;
  const icon = () => TONE_ICON[value().tone];
  return (
    <BaseToast
      transitionStatus={props.entry().status}
      accessibilityLabel={
        value().description
          ? `${value().title}. ${value().description}`
          : value().title
      }
      onDismissRequest={() => dismiss(props.entry().id)}
      class={CARD.card}
      startingClass="opacity-0 translate-y-4"
      endingClass="opacity-0 scale-95"
    >
      {icon() ? (
        <View class="pt-0.5">
          <Glyph
            icon={icon() as IconData}
            size="md"
            color={look === 'android' ? 'background' : TONE_COLOR[value().tone]}
          />
        </View>
      ) : null}
      <View class="flex-1 gap-0.5">
        <Text class={CARD.title}>{value().title}</Text>
        {value().description ? (
          <Text class={CARD.description}>{value().description}</Text>
        ) : null}
      </View>
      {value().action && look === 'android' ? (
        <BaseButton
          onPress={() => runAction(props.entry().id)}
          disabled={value().action?.disabled}
          accessibilityLabel={value().action?.label ?? ''}
          class={`h-10 -mr-2 items-center justify-center rounded-full px-3 active:opacity-70 disabled:opacity-40 ${FOCUS_RING}`}
        >
          <Text class="text-m3-label-lg font-bold text-background">
            {value().action?.label ?? ''}
          </Text>
        </BaseButton>
      ) : value().action ? (
        <Button
          label={value().action?.label ?? ''}
          kind="subtle"
          size="sm"
          disabled={value().action?.disabled}
          onPress={() => runAction(props.entry().id)}
        />
      ) : null}
    </BaseToast>
  );
}

/** Where toasts show. `mount` renders it; Apps do not. */
export function ToastRegion(): JSX.Element {
  const compact = () => paneSize() === 'compact';
  // On iOS and Android toasts rise above an `AppShell`'s bottom bar.
  const clear = () => look !== 'web' && bottomBarShown();
  return (
    <Overlay
      class={`pointer-events-none inset-x-0 bottom-0 p-4 pb-[env(safe-area-inset-bottom)] ${compact() ? 'items-center' : 'items-end'} ${clear() ? 'mb-20' : ''}`}
    >
      <ToastStack
        placement={compact() ? 'bottomCenter' : 'bottomRight'}
        class="pointer-events-auto w-full max-w-sm"
        onExpandedChange={(event) => expanded.set(event.expanded)}
        // Escape belongs to the dialog, sheet or menu the user is in; a toast
        // goes on its own, by a swipe or by its action.
        closeOnEscape={false}
      >
        <Each of={shown()} key={(entry) => entry.id}>
          {(entry) => <ToastCard entry={entry} />}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
