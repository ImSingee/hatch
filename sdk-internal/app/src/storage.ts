// @ts-self-types="./storage.d.ts"
/**
 * @hatch/app/storage — listing and change notifications for an App's browser
 * storage.
 *
 * Hatch already scopes `localStorage` and `sessionStorage` to the App in
 * every App page and widget. This module adds what the standard API lacks:
 * `keys()`/`entries()`, and `watch()`, which also reports changes made in the
 * same page.
 */
import {
  APP_STORAGE_CHANGE_EVENT,
  APP_STORAGE_GLOBAL,
  type AppStorageArea,
  type AppStorageChangeDetail,
  type InstalledAppStorage,
} from './storage-shared.js';

export type { AppStorageArea };

export type AppStorageOptions = {
  /**
   * `'local'` (default) persists across browser sessions; `'session'` lasts
   * for the tab, like `sessionStorage`.
   */
  area?: AppStorageArea;
};

/** One key that changed in this App's storage. */
export type AppStorageChange = {
  key: string;
  oldValue: string | null;
  newValue: string | null;
};

export type AppStorageListener = (change: AppStorageChange) => void;

/**
 * The `Storage` methods of this App's area, plus listing and change
 * notifications. It reads and writes the same entries as the page's
 * `localStorage` (or `sessionStorage`).
 */
export type AppStorage = {
  readonly area: AppStorageArea;
  /** Number of keys this App has stored in the area. */
  readonly length: number;
  /** The key at `index` in {@link keys} order, or `null`. */
  key(index: number): string | null;
  getItem(key: string): string | null;
  /** Stores `String(value)`; throws the browser's quota error when full. */
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Removes only this App's keys; other Apps and Hatch are untouched. */
  clear(): void;
  /** This App's keys. */
  keys(): string[];
  /** This App's `[key, value]` pairs. */
  entries(): [string, string][];
  /**
   * Calls `listener` for every key that changes, whether the change was made
   * in this page (through this object or `localStorage` directly), in another
   * tab, or in another frame of this App such as a dashboard widget. Returns
   * a function that stops listening.
   */
  watch(listener: AppStorageListener): () => void;
  /** Like {@link watch}, for one key. */
  watch(key: string, listener: AppStorageListener): () => void;
};

function installed(): InstalledAppStorage {
  const value = (window as unknown as Record<symbol, unknown>)[
    APP_STORAGE_GLOBAL
  ];
  if (!value) {
    throw new Error(
      '@hatch/app/storage is only available in App pages and widgets ' +
        'served by Hatch.',
    );
  }
  return value as InstalledAppStorage;
}

/**
 * This App's view of `localStorage` (or `sessionStorage` with
 * `{ area: 'session' }`). Instances for the same area share data and notify
 * each other's watchers.
 */
export function createAppStorage(options: AppStorageOptions = {}): AppStorage {
  const area = options.area ?? 'local';
  if (area !== 'local' && area !== 'session') {
    throw new TypeError(`Unknown App storage area: ${String(area)}`);
  }
  // An absent area is blocked by the browser; reading it rethrows that error.
  const storage =
    installed().areas[area] ??
    window[area === 'local' ? 'localStorage' : 'sessionStorage'];

  const keys = (): string[] => {
    const result: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null) result.push(key);
    }
    return result;
  };
  const snapshot = () =>
    new Map(keys().map((key) => [key, storage.getItem(key)!]));

  const listeners = new Set<{ key?: string; fn: AppStorageListener }>();
  // Last values seen while watching, so clearing the whole area (which the
  // browser reports with a null key) becomes per-key removals.
  let known = new Map<string, string>();
  let detach: (() => void) | undefined;

  const emit = (change: AppStorageChange) => {
    if (change.newValue === null) known.delete(change.key);
    else known.set(change.key, change.newValue);
    // Snapshot: a listener may subscribe or unsubscribe while being called.
    for (const listener of Array.from(listeners)) {
      if (listener.key !== undefined && listener.key !== change.key) continue;
      // One failing listener must not hide the change from the others.
      try {
        listener.fn(change);
      } catch (error) {
        reportError(error);
      }
    }
  };

  const resync = () => {
    const current = snapshot();
    for (const [key, oldValue] of known) {
      if (!current.has(key)) emit({ key, oldValue, newValue: null });
    }
    for (const [key, newValue] of current) {
      const oldValue = known.get(key) ?? null;
      if (oldValue !== newValue) emit({ key, oldValue, newValue });
    }
  };

  const onChange = (key: string | null) => {
    if (key === null) {
      resync();
      return;
    }
    const newValue = storage.getItem(key);
    // Compare current values: `known` is a complete snapshot while watching,
    // so an absent key is null. Queued events may carry stale old values;
    // reading the store collapses bursts and ignores undone changes.
    const previous = known.get(key) ?? null;
    if (previous !== newValue) emit({ key, oldValue: previous, newValue });
  };

  const attach = () => {
    known = snapshot();
    // Changes from other documents, already relative to this App.
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === storage) onChange(event.key);
    };
    const onLocal = (event: Event) => {
      const detail = (event as CustomEvent<AppStorageChangeDetail>).detail;
      if (detail?.area === area) onChange(detail.key);
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(APP_STORAGE_CHANGE_EVENT, onLocal);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(APP_STORAGE_CHANGE_EVENT, onLocal);
    };
  };

  function watch(
    keyOrListener: string | AppStorageListener,
    maybeListener?: AppStorageListener,
  ): () => void {
    const entry =
      typeof keyOrListener === 'function'
        ? { fn: keyOrListener }
        : { key: String(keyOrListener), fn: maybeListener! };
    if (typeof entry.fn !== 'function') {
      throw new TypeError('watch() requires a listener function');
    }
    if (listeners.size === 0) detach = attach();
    listeners.add(entry);
    return () => {
      if (!listeners.delete(entry) || listeners.size > 0) return;
      detach?.();
      detach = undefined;
    };
  }

  return {
    area,
    get length() {
      return storage.length;
    },
    key: (index) => storage.key(index),
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    clear: () => storage.clear(),
    keys,
    entries: () => keys().map((key) => [key, storage.getItem(key)!]),
    watch,
  };
}
