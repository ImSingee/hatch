// @ts-self-types="./storage-install.d.ts"
/**
 * @hatch/app/storage/install — the platform runs this before any App page or
 * widget code. Apps never import it.
 *
 * App pages and widgets share the platform origin, so the browser's
 * `localStorage` and `sessionStorage` are shared by Hatch and every App. This
 * replaces both on the window with Storage-compatible views over the keys
 * prefixed with the App's immutable id. App code and the libraries it bundles
 * keep using the standard API and can no longer overwrite, list, clear or
 * observe another App's entries by accident. It is a collision boundary, not
 * a security boundary: same-origin code can still reach the raw areas.
 */
import {
  APP_STORAGE_CHANGE_EVENT,
  APP_STORAGE_GLOBAL,
  type AppStorageArea,
  type AppStorageChangeDetail,
  type InstalledAppStorage,
  type InstalledAppStorageArea,
} from './storage-shared.js';

type StorageWindow = Window & typeof globalThis;

const AREAS = [
  ['local', 'localStorage'],
  ['session', 'sessionStorage'],
] as const;

/**
 * The persisted key layout. Changing it orphans every value already stored
 * in users' browsers, so treat it as a data format.
 */
function appStoragePrefix(appId: string): string {
  return `hatch:app:${appId}:`;
}

function scopedStorage(
  target: StorageWindow,
  native: Storage,
  prefix: string,
  area: AppStorageArea,
): InstalledAppStorageArea {
  const keys = (): string[] => {
    const result: string[] = [];
    for (let index = 0; index < native.length; index += 1) {
      const full = native.key(index);
      if (full?.startsWith(prefix)) result.push(full.slice(prefix.length));
    }
    return result;
  };
  const getItem = (key: string): string | null =>
    native.getItem(prefix + String(key));
  const write = (key: string, update: (full: string) => void) => {
    const k = String(key);
    const full = prefix + k;
    const oldValue = native.getItem(full);
    update(full);
    const newValue = native.getItem(full);
    if (oldValue === newValue) return;
    target.dispatchEvent(
      new target.CustomEvent<AppStorageChangeDetail>(APP_STORAGE_CHANGE_EVENT, {
        detail: { area, key: k, oldValue, newValue },
      }),
    );
  };
  const setItem = (key: string, value: string) =>
    write(key, (full) => native.setItem(full, String(value)));
  const removeItem = (key: string) =>
    write(key, (full) => native.removeItem(full));
  const methods: Record<string, unknown> = {
    key: (index: number) => keys()[Number(index) >>> 0] ?? null,
    getItem,
    setItem,
    removeItem,
    clear: () => {
      for (const key of keys()) removeItem(key);
    },
  };

  // Storage exposes stored keys as properties unless the prototype chain
  // already defines that name; assignments always store.
  const proto = target.Storage.prototype;
  const isStoredName = (prop: string | symbol): prop is string =>
    typeof prop === 'string' && !(prop in proto) && getItem(prop) !== null;

  const storage = new Proxy(Object.create(proto) as Storage, {
    get(object, prop, receiver) {
      if (prop === 'length') return keys().length;
      if (typeof prop === 'string' && Object.hasOwn(methods, prop)) {
        return methods[prop];
      }
      if (typeof prop === 'symbol' || prop in proto) {
        return Reflect.get(object, prop, receiver);
      }
      return getItem(prop) ?? undefined;
    },
    set(object, prop, value, receiver) {
      if (typeof prop === 'symbol') {
        return Reflect.set(object, prop, value, receiver);
      }
      setItem(prop, value);
      return true;
    },
    has(object, prop) {
      return isStoredName(prop) || Reflect.has(object, prop);
    },
    deleteProperty(object, prop) {
      if (isStoredName(prop)) removeItem(prop);
      else Reflect.deleteProperty(object, prop);
      return true;
    },
    defineProperty(object, prop, descriptor) {
      if (typeof prop === 'symbol') {
        return Reflect.defineProperty(object, prop, descriptor);
      }
      setItem(prop, descriptor.value);
      return true;
    },
    ownKeys(object) {
      return [
        ...keys().filter((key) => !(key in proto)),
        ...Reflect.ownKeys(object),
      ];
    },
    getOwnPropertyDescriptor(object, prop) {
      if (!isStoredName(prop)) {
        return Reflect.getOwnPropertyDescriptor(object, prop);
      }
      return {
        value: getItem(prop),
        writable: true,
        enumerable: true,
        configurable: true,
      };
    },
  });
  return { storage, keys };
}

/**
 * Scope `localStorage` and `sessionStorage` of `target` to `appId`. Runs once
 * per window; later calls are ignored.
 */
export function installAppStorage(
  appId: string,
  target: StorageWindow = window,
): void {
  if (!appId) throw new TypeError('installAppStorage requires an App id');
  if (Object.hasOwn(target, APP_STORAGE_GLOBAL)) return;
  const prefix = appStoragePrefix(appId);
  const areas: Partial<Record<AppStorageArea, InstalledAppStorageArea>> = {};
  const scopedByNative = new Map<Storage, Storage>();

  for (const [area, property] of AREAS) {
    let native: Storage;
    try {
      native = target[property];
    } catch {
      // Blocked storage keeps throwing its native error on access.
      continue;
    }
    const scope = scopedStorage(target, native, prefix, area);
    const scoped = scope.storage;
    areas[area] = scope;
    scopedByNative.set(native, scoped);
    try {
      Object.defineProperty(target, property, {
        configurable: false,
        enumerable: true,
        get: () => scoped,
      });
    } catch {
      // A browser that refuses the override still serves @hatch/app/storage.
    }
  }

  Object.defineProperty(target, APP_STORAGE_GLOBAL, {
    value: Object.freeze({
      appId,
      areas: Object.freeze(areas),
    } satisfies InstalledAppStorage),
  });

  // Registered before any App code, so this capture listener runs first and
  // App listeners only ever see this App's keys, relative to its prefix.
  target.addEventListener(
    'storage',
    (event) => {
      const scoped = event.storageArea
        ? scopedByNative.get(event.storageArea)
        : undefined;
      if (!scoped) return;
      event.stopImmediatePropagation();
      if (event.key !== null && !event.key.startsWith(prefix)) return;
      const translated = new target.StorageEvent('storage', {
        key: event.key === null ? null : event.key.slice(prefix.length),
        oldValue: event.oldValue,
        newValue: event.newValue,
        url: event.url,
      });
      // StorageEvent only accepts a native Storage in its initializer.
      Object.defineProperty(translated, 'storageArea', { value: scoped });
      target.dispatchEvent(translated);
    },
    true,
  );
}
