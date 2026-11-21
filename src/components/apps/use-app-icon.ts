import {
  QueryClientContext,
  queryOptions,
  useQuery,
} from '@tanstack/react-query';
import { useContext } from 'react';

/**
 * Icon key per App id; Apps without an icon are absent. Fetched over plain
 * HTTP so the App tile, rendered all over the UI, imports no server module.
 */
export const appIconsQueryOptions = queryOptions({
  queryKey: ['apps', 'icons'],
  queryFn: async ({ signal }): Promise<Record<string, string>> => {
    const response = await fetch('/api/images/app-icons', { signal });
    if (!response.ok) throw new Error('Could not load app icons.');
    return (await response.json()) as Record<string, string>;
  },
  staleTime: 30_000,
  // A missing icon list only means monograms; never worth a retry storm.
  retry: false,
});

/** Stored size to request for a rendered side, covering 3x displays. */
export function appIconUrl(
  appId: string,
  key: string,
  size: 64 | 128 | 256,
): string {
  return `/api/app/${encodeURIComponent(appId)}/icon?v=${key}&size=${size}`;
}

/** Whether App icons can be looked up in this React tree. */
export function useHasAppIcons(): boolean {
  return useContext(QueryClientContext) !== undefined;
}

/** The icon key of an App, or null while it shows its monogram. */
export function useAppIconKey(appId: string | undefined): string | null {
  const { data } = useQuery(appIconsQueryOptions);
  return (appId !== undefined && data?.[appId]) || null;
}
