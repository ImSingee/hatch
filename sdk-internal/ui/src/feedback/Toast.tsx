import { Overlay, Text, View, signal } from 'nsh';
import type { JSX } from 'nsh';
import {
  Toast as BaseToast,
  ToastManager,
  ToastStack,
  type ToastEntry,
} from 'nsh/base';
import { Each } from '../core/control';
import { paneSize } from '../core/env';
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

type Shown = Required<Pick<ToastOptions, 'title' | 'tone'>> &
  Pick<ToastOptions, 'description' | 'action'>;

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

const VISIBLE = 3;
const TICK_MS = 50;

const manager = new ToastManager();
const shown = signal<ToastEntry[]>([]);
const expanded = signal(false);
let timer: number | undefined;
let nextId = 0;

function sync(): void {
  shown.set(manager.visible(VISIBLE));
  if (manager.isEmpty() && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function tick(): void {
  if (manager.advance(expanded()).changed) sync();
}

function dismiss(id: string): void {
  manager.dismiss(id);
  sync();
}

function show(options: ToastOptions): string {
  nextId += 1;
  const id = `toast-${nextId}`;
  const value: Shown = {
    title: options.title,
    description: options.description,
    tone: options.tone ?? 'neutral',
    action: options.action,
  };
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
      class="flex-row items-start gap-3 rounded-(--radius-lg) border border-hairline bg-popover px-4 py-3 shadow-dock transition-all duration-200"
      startingClass="opacity-0 translate-y-4"
      endingClass="opacity-0 scale-95"
    >
      {icon() ? (
        <View class="pt-0.5">
          <Glyph
            icon={icon() as IconData}
            size="md"
            color={TONE_COLOR[value().tone]}
          />
        </View>
      ) : null}
      <View class="flex-1 gap-0.5">
        <Text class="text-body font-label text-popover-foreground">
          {value().title}
        </Text>
        {value().description ? (
          <Text class="text-caption text-muted-foreground">
            {value().description}
          </Text>
        ) : null}
      </View>
      {value().action ? (
        <Button
          label={(value().action as Action).label}
          kind="subtle"
          size="sm"
          onPress={() => {
            (value().action as Action).onPress();
            dismiss(props.entry().id);
          }}
        />
      ) : null}
    </BaseToast>
  );
}

/** Where toasts show. `mount` renders it; Apps do not. */
export function ToastRegion(): JSX.Element {
  const compact = () => paneSize() === 'compact';
  return (
    <Overlay
      class={`pointer-events-none inset-x-0 bottom-0 p-4 pb-[env(safe-area-inset-bottom)] ${compact() ? 'items-center' : 'items-end'}`}
    >
      <ToastStack
        placement={compact() ? 'bottomCenter' : 'bottomRight'}
        class="pointer-events-auto w-full max-w-sm"
        onExpandedChange={(event) => expanded.set(event.expanded)}
        onCancel={() => {
          const newest = shown()
            .filter((entry) => entry.status !== 'ending')
            .at(-1);
          if (newest) dismiss(newest.id);
        }}
      >
        <Each of={shown()} key={(entry) => entry.id}>
          {(entry) => <ToastCard entry={entry} />}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
