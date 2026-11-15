/** Contract between the platform-installed storage shim and @hatch/app/storage. */

/** Which browser storage area backs an App storage object. */
export type AppStorageArea = 'local' | 'session';

/** Window property holding {@link InstalledAppStorage} once the shim runs. */
export const APP_STORAGE_GLOBAL = Symbol.for('hatch.appStorage');

/**
 * Dispatched on the window after every change made through an App storage
 * area in this document; the browser's `storage` event covers other documents.
 */
export const APP_STORAGE_CHANGE_EVENT = 'hatch:app-storage-change';

export type AppStorageChangeDetail = {
  area: AppStorageArea;
  /** The App-relative key. */
  key: string;
  oldValue: string | null;
  newValue: string | null;
};

export type InstalledAppStorage = {
  readonly appId: string;
  /** Scoped areas; an area is absent when the browser blocks its storage. */
  readonly areas: Partial<Record<AppStorageArea, Storage>>;
};
