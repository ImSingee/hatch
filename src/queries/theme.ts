import { queryOptions, type QueryFilters } from '@tanstack/react-query';
import { getThemeFn, listThemesFn } from '~server/theme';

/**
 * The signed-in user's theme: their active theme, accent and dock labels
 * are their own.
 */
export const themeQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'theme'],
    queryFn: async () => {
      const theme = await getThemeFn();
      if (theme.userId !== userId)
        throw new Error('Your account changed. Reload the page to continue.');
      return theme;
    },
  });

/** The shared theme library: presets, then custom themes. */
export const themesQueryOptions = queryOptions({
  queryKey: ['theme', 'library'],
  queryFn: () => listThemesFn(),
});

/**
 * Every cached theme and the library, to re-read after a change elsewhere
 * or a reconnect.
 */
export const themeQueries: QueryFilters = {
  predicate: ({ queryKey }) =>
    (queryKey[0] === 'account' && queryKey[2] === 'theme') ||
    queryKey[0] === 'theme',
};
