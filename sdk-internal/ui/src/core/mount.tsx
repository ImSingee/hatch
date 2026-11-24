import { View, host, mount as nshMount, setTheme } from 'nsh';
import type { Component, JSX, Theme } from 'nsh';
import { AlertDialogHost } from '../feedback/Dialog';
import { ToastRegion } from '../feedback/Toast';
import builtInTheme from '../theme.json';

type ThemeVars = Record<string, string | number>;
type ThemeDocument = { cssVars?: { theme?: ThemeVars; light?: ThemeVars } };

function isThemeDocument(value: unknown): value is ThemeDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ThemeDocument).cssVars === 'object'
  );
}

/**
 * The theme in what the host sent: `hatch.theme.get` answers
 * `{ ok: true, theme }`, the `hatch.theme` event carries `{ theme }` (see
 * `docs/app-native-runtime.md`); a bare theme is accepted too.
 */
function themeIn(value: unknown): ThemeDocument | null {
  if (isThemeDocument(value)) return value;
  if (typeof value !== 'object' || value === null) return null;
  const message = value as { ok?: boolean; theme?: unknown };
  if (message.ok === false) return null;
  return isThemeDocument(message.theme) ? message.theme : null;
}

/**
 * Applies a theme the host sent, over the built-in Desk theme: NSH replaces
 * the whole theme, so a token the host left out keeps its built-in value
 * instead of leaving the classes that name it unresolved.
 */
export function applyHostTheme(value: unknown): void {
  const sent = themeIn(value);
  if (!sent) return;
  const theme: Theme = {
    cssVars: {
      theme: { ...builtInTheme.cssVars.theme, ...sent.cssVars?.theme },
      light: { ...builtInTheme.cssVars.light, ...sent.cssVars?.light },
    },
  };
  try {
    setTheme(theme);
  } catch (error) {
    // NSH keeps the theme shown when it cannot read one.
    console.warn(
      `@hatch/ui: the host's theme was not applied: ${String(error)}`,
    );
  }
}

/** Follows the shell's theme: `hatch.theme.get` once, then `hatch.theme`. */
function followHostTheme(): void {
  if (!host.available()) return;
  host.on('hatch.theme', applyHostTheme);
  host.call('hatch.theme.get').then(applyHostTheme, () => {
    // A host without the call keeps the built-in theme.
  });
}

function Root(props: { app: Component }): JSX.Element {
  const App = props.app;
  return (
    <View class="flex-1 bg-surface-window text-foreground font-sans">
      <App />
      <ToastRegion />
      <AlertDialogHost />
    </View>
  );
}

/**
 * Starts the App: renders `app` into the shell, follows the shell's theme and
 * hosts toasts. Call it once, in `app/main.tsx`.
 */
export function mount(app: Component): () => void {
  followHostTheme();
  return nshMount(Root, { app });
}
