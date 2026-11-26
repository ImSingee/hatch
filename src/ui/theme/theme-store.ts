/**
 * The theme this browser draws. The instance setting (`ui.theme`, read
 * through `~queries/theme`) is the source of truth: the server resolves the
 * light and the dark theme into every token, and this store keeps the last
 * answer in localStorage so a reload paints the right theme before the
 * setting has been fetched. Before any answer, the built-in `desk` and
 * `desk-dark` presets apply.
 */
import { useMemo, useSyncExternalStore } from 'react';
import {
  BUILT_IN_THEME,
  THEME_MODES,
  isResolvedTheme,
  resolvePreset,
  type ResolvedTheme,
  type ThemeAppearance,
  type ThemeMode,
} from '../../../packages/hatch-design-tokens/src';
import { applyAccent } from './accent-store';
import { DEFAULT_ACCENT, isAccentName, type AccentName } from './accents';

export type WebThemeState = {
  mode: ThemeMode;
  /** null: each theme shows its own primary. */
  accent: AccentName | null;
  light: ResolvedTheme;
  dark: ResolvedTheme;
};

const STORAGE_KEY = 'hatch.theme.v1';
const BOOT_STYLE_ID = 'hatch-theme-boot';
const DARK_QUERY = '(prefers-color-scheme: dark)';

const BUILT_IN: WebThemeState = {
  mode: 'light',
  accent: DEFAULT_ACCENT,
  light: BUILT_IN_THEME,
  dark: resolvePreset('desk-dark'),
};

/** A cached state, or null when it is missing or from another format. */
function parseCached(raw: string | null): WebThemeState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WebThemeState>;
    if (
      !(THEME_MODES as readonly unknown[]).includes(value.mode) ||
      !(value.accent === null || isAccentName(value.accent)) ||
      !isResolvedTheme(value.light, 'light') ||
      !isResolvedTheme(value.dark, 'dark')
    )
      return null;
    return value as WebThemeState;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let current: WebThemeState | undefined;

function read(): WebThemeState {
  if (current === undefined) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage can be blocked; the built-in themes apply until the fetch.
    }
    current = parseCached(stored) ?? BUILT_IN;
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply the instance theme now and remember it for the next load. */
export function applyThemeState(next: WebThemeState): void {
  // Native App players and older pages read the accent name on its own.
  applyAccent(next.accent ?? DEFAULT_ACCENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the next load starts from the built-in themes.
  }
  current = next;
  for (const listener of listeners) listener();
}

export function useThemeState(): WebThemeState {
  return useSyncExternalStore(subscribe, read, () => BUILT_IN);
}

function subscribeDark(listener: () => void): () => void {
  const query = matchMedia(DARK_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** Whether this device prefers dark appearance, live. */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(
    subscribeDark,
    () => matchMedia(DARK_QUERY).matches,
    () => false,
  );
}

export function activeAppearance(
  mode: ThemeMode,
  prefersDark: boolean,
): ThemeAppearance {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** The resolved theme this browser draws now: the mode, then the device. */
export function useActiveTheme(): ResolvedTheme {
  const state = useThemeState();
  const prefersDark = usePrefersDark();
  return state[activeAppearance(state.mode, prefersDark)];
}

/**
 * The document's own ground. `body` is listed too: before React mounts, the
 * prerendered shell's Mantine variables are the built-in light ones, and
 * Mantine paints `body` from them. A native-host page keeps its transparent
 * ground (`desk.css` outranks these selectors).
 */
function rootRule(background: string, appearance: ThemeAppearance): string {
  return `:root{background-color:${background};color-scheme:${appearance}}body{background-color:${background}}`;
}

/**
 * Keep the document's own colour (behind the app, and in the page's
 * overscroll), its `color-scheme` and its `theme-color` on the theme. The
 * macOS app reads `theme-color` to match its window to the theme.
 */
export function applyDocumentTheme(theme: ResolvedTheme): void {
  let style = document.getElementById(BOOT_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = BOOT_STYLE_ID;
    document.head.append(style);
  }
  style.textContent = rootRule(theme.colors.background, theme.appearance);
  let meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = theme.colors.background;
}

/**
 * Runs in `<head>` before the first paint: draws the document in the cached
 * theme's ground and colour scheme, so a dark theme never flashes light.
 * Anything unreadable leaves the built-in light ground.
 */
export const THEME_BOOT_SCRIPT = `try{var t=JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)}));var d=t.mode==='system'?matchMedia(${JSON.stringify(DARK_QUERY)}).matches:t.mode==='dark';var r=d?t.dark:t.light;var b=String(r.colors.background);if(/^#[0-9A-Fa-f]{6}$/.test(b)&&(r.appearance==='light'||r.appearance==='dark')){var e=document.documentElement;e.dataset.mantineColorScheme=r.appearance;var s=document.createElement('style');s.id=${JSON.stringify(BOOT_STYLE_ID)};s.textContent=':root{background-color:'+b+';color-scheme:'+r.appearance+'}body{background-color:'+b+'}';document.head.appendChild(s);var m=document.createElement('meta');m.name='theme-color';m.content=b;document.head.appendChild(m)}}catch(x){}`;

/** A short, stable fingerprint of a resolved theme (FNV-1a over its JSON). */
function themeKeyOf(theme: ResolvedTheme): string {
  const text = JSON.stringify(theme);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export type SurfaceTheme = {
  accent: AccentName;
  appearance: ThemeAppearance;
  themeKey: string;
};

/**
 * What an App surface tells its native player about the theme: the accent
 * (older players follow only that) and which resolved theme it draws.
 */
export function useSurfaceTheme(): SurfaceTheme {
  const state = useThemeState();
  const theme = useActiveTheme();
  const accent = state.accent ?? DEFAULT_ACCENT;
  const themeKey = themeKeyOf(theme);
  return useMemo(
    () => ({ accent, appearance: theme.appearance, themeKey }),
    [accent, theme.appearance, themeKey],
  );
}
