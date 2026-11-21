import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext } from 'react';
import { appIconsQueryOptions } from '~queries/app-icons';

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
