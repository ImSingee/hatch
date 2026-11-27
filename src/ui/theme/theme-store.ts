/**
 * The theme this browser draws. The signed-in user's setting (read through
 * `~queries/theme` and applied by `ThemeSync`) is the source of truth: the
 * server resolves their active theme into every token, and this store keeps the last answer in
 * localStorage so a reload paints the right theme before the setting has
 * been fetched. Before any answer, the built-in `desk` applies. A dark theme
 * is drawn dark whatever the device prefers.
 */
import { useMemo, useSyncExternalStore } from 'react';
import {
  BUILT_IN_THEME,
  isResolvedTheme,
  type ResolvedTheme,
} from '../../../packages/hatch-design-tokens/src';
import { applyAccent } from './accent-store';
import { DEFAULT_ACCENT, isAccentName, type AccentName } from './accents';

export type WebThemeState = {
  /** null: the theme shows its own primary. */
  accent: AccentName | null;
  /** The active theme, with the accent applied. */
  theme: ResolvedTheme;
};

const STORAGE_KEY = 'hatch.theme.v2';
const BOOT_STYLE_ID = 'hatch-theme-boot';

const BUILT_IN: WebThemeState = { accent: null, theme: BUILT_IN_THEME };

/** A cached state, or null when it is missing or from another format. */
function parseCached(raw: string | null): WebThemeState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WebThemeState>;
    if (
      !(value.accent === null || isAccentName(value.accent)) ||
      !isResolvedTheme(value.theme)
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
      // Storage can be blocked; the built-in theme applies until the fetch.
    }
    current = parseCached(stored) ?? BUILT_IN;
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply the user's theme now and remember it for the next load. */
export function applyThemeState(next: WebThemeState): void {
  // Native App players and older pages read the accent name on its own.
  applyAccent(next.accent ?? DEFAULT_ACCENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not remembered; the next load starts from the built-in theme.
  }
  current = next;
  for (const listener of listeners) listener();
}

export function useThemeState(): WebThemeState {
  return useSyncExternalStore(subscribe, read, () => BUILT_IN);
}

/** The resolved theme this browser draws now. */
export function useActiveTheme(): ResolvedTheme {
  return useThemeState().theme;
}

/**
 * The document's own ground. `body` is listed too: before React mounts, the
 * prerendered shell's Mantine variables are the built-in light ones, and
 * Mantine paints `body` from them. A native-host page keeps its transparent
 * ground (`desk.css` outranks these selectors).
 */
function rootRule(theme: ResolvedTheme): string {
  const background = theme.colors.background;
  return `:root{background-color:${background};color-scheme:${theme.appearance}}body{background-color:${background}}`;
}

/**
 * Keep the document's own colour (behind the app, and in the page's
 * overscroll), its `color-scheme` and its `theme-color` on the theme. The
 * macOS app reads `theme-color` to give its window the theme's appearance.
 */
export function applyDocumentTheme(theme: ResolvedTheme): void {
  let style = document.getElementById(BOOT_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = BOOT_STYLE_ID;
    document.head.append(style);
  }
  style.textContent = rootRule(theme);
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
export const THEME_BOOT_SCRIPT = `try{var r=JSON.parse(localStorage.getItem(${JSON.stringify(STORAGE_KEY)})).theme;var b=String(r.colors.background);if(/^#[0-9A-Fa-f]{6}$/.test(b)&&(r.appearance==='light'||r.appearance==='dark')){var e=document.documentElement;e.dataset.mantineColorScheme=r.appearance;var s=document.createElement('style');s.id=${JSON.stringify(BOOT_STYLE_ID)};s.textContent=':root{background-color:'+b+';color-scheme:'+r.appearance+'}body{background-color:'+b+'}';document.head.appendChild(s);var m=document.createElement('meta');m.name='theme-color';m.content=b;document.head.appendChild(m)}}catch(x){}`;

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

export type SurfaceTheme = { accent: AccentName; themeKey: string };

/**
 * What an App surface tells its native player about the theme: the accent
 * (older players follow only that) and a key that changes with the theme.
 */
export function useSurfaceTheme(): SurfaceTheme {
  const state = useThemeState();
  const accent = state.accent ?? DEFAULT_ACCENT;
  const themeKey = themeKeyOf(state.theme);
  return useMemo(() => ({ accent, themeKey }), [accent, themeKey]);
}
