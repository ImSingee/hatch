/**
 * The accent name this browser applies, kept in localStorage under
 * `hatch.accent`: native App players read it before their surface connects.
 * The colours themselves come from the resolved theme (`theme-store.ts`).
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
  try {
    localStorage.setItem(STORAGE_KEY, accent);
  } catch {
    // Not remembered; the next load starts from the default accent.
  }
  if (accent === current) return;
  current = accent;
  for (const listener of listeners) listener();
}

/** The accent name native App surfaces send to their players. */
export function useAccent(): AccentName {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_ACCENT);
}
