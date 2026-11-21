/**
 * The accent this browser applies. The instance setting is the source of
 * truth; the last value seen is cached in localStorage so a reload paints in
 * the right accent before the setting has been fetched.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_ACCENT, isAccentName, type AccentName } from './accents';

const STORAGE_KEY = 'hatch.accent';

const listeners = new Set<() => void>();
let current: AccentName | undefined;

function read(): AccentName {
  if (current === undefined) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage can be blocked; the default accent applies until the fetch.
    }
    current = isAccentName(stored) ? stored : DEFAULT_ACCENT;
  }
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply an accent now and remember it for the next load. */
export function applyAccent(accent: AccentName): void {
  document.documentElement.dataset.accent = accent;
  try {
    localStorage.setItem(STORAGE_KEY, accent);
  } catch {
    // Not remembered; the next load starts from the default accent.
  }
  if (accent === current) return;
  current = accent;
  for (const listener of listeners) listener();
}

/**
 * The accent to build the theme from. The prerendered shell uses the default
 * accent; the browser switches to the cached one while hydrating.
 */
export function useAccent(): AccentName {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_ACCENT);
}

/**
 * Runs in `<head>` before the first paint: marks `<html>` with the cached
 * accent so the `ACCENT_CSS` rules colour the shell. The value is only ever
 * matched against those rules' selectors, so an unknown one has no effect.
 */
export const ACCENT_BOOT_SCRIPT = `try{var a=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});if(a)document.documentElement.dataset.accent=a}catch(e){}`;
