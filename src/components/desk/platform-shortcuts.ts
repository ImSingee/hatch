import { useEffect, useEffectEvent } from 'react';
import {
  keyboardEventChord,
  resolveKeyboardChord,
  type KeyboardChordEvent,
} from '~/keyboard-shortcut';

/**
 * Every platform keyboard shortcut, by stable id. Adding a shortcut here is
 * all it takes: the shell's own document, every App page and widget frame and
 * the desktop menu dispatch through `PLATFORM_SHORTCUTS`, and an App that
 * reserved the chord in its manifest (`keyboard.reserve`) keeps it.
 *
 * `reservable: false` marks a shortcut that must keep working inside every
 * App, such as a future escape hatch; App reservations of its chord are
 * ignored. Escape is deliberately not here: Apps use it for their own layers.
 */
export const PLATFORM_SHORTCUTS = [
  { id: 'palette.open', keys: 'mod+k', reservable: true },
] as const satisfies readonly {
  id: string;
  keys: string;
  reservable: boolean;
}[];

export type PlatformShortcutId = (typeof PLATFORM_SHORTCUTS)[number]['id'];

const ARIA_MODIFIERS: Record<string, string> = {
  ctrl: 'Control',
  meta: 'Meta',
  alt: 'Alt',
  shift: 'Shift',
};
const APPLE_SYMBOLS: Record<string, string> = {
  ctrl: '⌃',
  meta: '⌘',
  alt: '⌥',
  shift: '⇧',
};
const OTHER_NAMES: Record<string, string> = {
  ctrl: 'Ctrl+',
  meta: 'Win+',
  alt: 'Alt+',
  shift: 'Shift+',
};

/**
 * How to show a shortcut on this platform: `aria` for `aria-keyshortcuts`
 * and `label` for a visible hint, such as `⌘K` on macOS and `Ctrl+K`
 * elsewhere.
 */
export function platformShortcutKeys(id: PlatformShortcutId) {
  const shortcut = PLATFORM_SHORTCUTS.find((item) => item.id === id);
  const apple = isApplePlatform();
  const chord = shortcut ? resolveKeyboardChord(shortcut.keys, apple) : null;
  if (!chord) return { aria: '', label: '' };
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const shown = key.length === 1 ? key.toUpperCase() : key;
  return {
    aria: [...parts.map((part) => ARIA_MODIFIERS[part]), shown].join('+'),
    label:
      parts
        .map((part) => (apple ? APPLE_SYMBOLS : OTHER_NAMES)[part])
        .join('') + shown,
  };
}

/** How a shortcut was triggered: a key press, or the desktop app's menu. */
export type PlatformShortcutSource = 'keyboard' | 'menu';

type Handler = (source: PlatformShortcutSource) => void;

const handlers = new Map<PlatformShortcutId, Handler>();

function isApplePlatform() {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** A reserved-chord list, resolved to physical chords for this platform. */
function resolveAll(chords: readonly string[]) {
  const apple = isApplePlatform();
  const resolved = new Set<string>();
  for (const chord of chords) {
    const physical = resolveKeyboardChord(chord, apple);
    if (physical) resolved.add(physical);
  }
  return resolved;
}

function shortcutForEvent(event: KeyboardChordEvent) {
  const pressed = keyboardEventChord(event);
  if (!pressed) return null;
  const apple = isApplePlatform();
  return (
    PLATFORM_SHORTCUTS.find(
      (shortcut) => resolveKeyboardChord(shortcut.keys, apple) === pressed,
    ) ?? null
  );
}

function isReserved(
  shortcut: (typeof PLATFORM_SHORTCUTS)[number],
  reserved: ReadonlySet<string>,
) {
  if (!shortcut.reservable) return false;
  const chord = resolveKeyboardChord(shortcut.keys, isApplePlatform());
  return chord !== null && reserved.has(chord);
}

type ShortcutKeyEvent = KeyboardChordEvent &
  Pick<
    KeyboardEvent,
    'isComposing' | 'preventDefault' | 'stopImmediatePropagation'
  >;

/**
 * Run the platform shortcut a key press names, unless the document it came
 * from reserved that chord. Returns whether the platform took the event; a
 * taken event is cancelled so the page underneath never sees it.
 */
function dispatchKeydown(
  event: ShortcutKeyEvent,
  reserved: ReadonlySet<string>,
  stop: boolean,
) {
  if (event.isComposing) return false;
  const shortcut = shortcutForEvent(event);
  if (!shortcut || isReserved(shortcut, reserved)) return false;
  const handler = handlers.get(shortcut.id);
  if (!handler) return false;
  event.preventDefault();
  if (stop) event.stopImmediatePropagation();
  handler('keyboard');
  return true;
}

const NO_RESERVATIONS: ReadonlySet<string> = new Set();

function onShellKeydown(event: KeyboardEvent) {
  dispatchKeydown(event, NO_RESERVATIONS, false);
}

/**
 * Handle a platform shortcut while the shell is mounted. The latest handler
 * for an id wins; the shell document listens for as long as any handler is
 * registered.
 */
export function usePlatformShortcut(id: PlatformShortcutId, handler: Handler) {
  const run = useEffectEvent(handler);
  useEffect(() => {
    const registered: Handler = (source) => run(source);
    if (handlers.size === 0) window.addEventListener('keydown', onShellKeydown);
    handlers.set(id, registered);
    return () => {
      if (handlers.get(id) === registered) handlers.delete(id);
      if (handlers.size === 0) {
        window.removeEventListener('keydown', onShellKeydown);
      }
    };
  }, [id]);
}

/** Frames whose platform shortcuts are attached, with their reservations. */
const frames = new WeakMap<Window, () => ReadonlySet<string>>();

/**
 * Make platform shortcuts work while focus is inside a same-origin App frame.
 * Key presses inside a frame never reach the shell's document, so the shell
 * listens on the frame's window too, in the capture phase: that is the first
 * stop of every key press, so App code cannot swallow a platform chord by
 * accident. `reserved` is read on every press, so a redeploy that changes
 * the App's reservations applies without reloading the frame.
 *
 * Returns the detach function. Call it before the frame's window goes away.
 */
export function attachPlatformShortcuts(
  frameWindow: Window,
  reserved: () => readonly string[],
): () => void {
  let source: readonly string[] | null = null;
  let resolved: ReadonlySet<string> = NO_RESERVATIONS;
  const current = () => {
    const next = reserved();
    if (next !== source) {
      source = next;
      resolved = resolveAll(next);
    }
    return resolved;
  };
  const onKeydown = (event: KeyboardEvent) => {
    dispatchKeydown(event, current(), true);
  };
  frameWindow.addEventListener('keydown', onKeydown, true);
  frames.set(frameWindow, current);
  return () => {
    frames.delete(frameWindow);
    try {
      frameWindow.removeEventListener('keydown', onKeydown, true);
    } catch {
      // window already torn down
    }
  };
}

/** The reservations of the frame that holds focus, if any. */
function focusedFrameReservations() {
  const active = document.activeElement;
  if (!(active instanceof HTMLIFrameElement) || !active.contentWindow) {
    return NO_RESERVATIONS;
  }
  return frames.get(active.contentWindow)?.() ?? NO_RESERVATIONS;
}

/**
 * Run a platform shortcut from outside the page's key events: the desktop
 * app's native menu, whose accelerator can fire while focus is inside an App.
 * Does nothing when the focused App reserved the shortcut's chord.
 */
export function runPlatformShortcut(
  id: PlatformShortcutId,
  source: PlatformShortcutSource,
) {
  const shortcut = PLATFORM_SHORTCUTS.find((item) => item.id === id);
  if (!shortcut) return;
  if (isReserved(shortcut, focusedFrameReservations())) return;
  handlers.get(id)?.(source);
}
