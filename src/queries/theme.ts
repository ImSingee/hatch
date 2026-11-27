import { queryOptions } from '@tanstack/react-query';
import { getThemeFn, listThemesFn } from '~server/theme';

export const themeQueryOptions = queryOptions({
  queryKey: ['theme'],
  queryFn: () => getThemeFn(),
});

/** The theme library: presets, then custom themes. */
export const themesQueryOptions = queryOptions({
  queryKey: ['theme', 'library'],
  queryFn: () => listThemesFn(),
});
