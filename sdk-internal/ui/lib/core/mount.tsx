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
 * Applies a theme the host sent, over the built-in Desk theme: NSH replaces
 * the whole theme, so a token the host left out keeps its built-in value
 * instead of leaving the classes that name it unresolved.
 */
export function applyHostTheme(value: unknown): void {
  if (!isThemeDocument(value)) return;
  const theme: Theme = {
    cssVars: {
      theme: { ...builtInTheme.cssVars.theme, ...value.cssVars?.theme },
      light: { ...builtInTheme.cssVars.light, ...value.cssVars?.light },
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
