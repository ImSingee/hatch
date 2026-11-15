// @ts-self-types="./storage-react.d.ts"
/** React binding for @hatch/app/storage. */
import { useCallback, useSyncExternalStore } from 'react';
import type { AppStorage } from './storage.js';

/**
 * Read one key of an {@link AppStorage} and re-render when it changes in this
 * page, another tab, or another frame of the App. The setter stores a string,
 * or removes the key when given `null`.
 */
export function useAppStorageItem(
  storage: AppStorage,
  key: string,
): [string | null, (value: string | null) => void] {
  const subscribe = useCallback(
    (onChange: () => void) => storage.watch(key, onChange),
    [storage, key],
  );
  const value = useSyncExternalStore(subscribe, () => storage.getItem(key));
  const setValue = useCallback(
    (next: string | null) => {
      if (next === null) storage.removeItem(key);
      else storage.setItem(key, next);
    },
    [storage, key],
  );
  return [value, setValue];
}
