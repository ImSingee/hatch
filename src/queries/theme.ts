import { queryOptions } from '@tanstack/react-query';
import { getThemeFn } from '~server/theme';

export const themeQueryOptions = queryOptions({
  queryKey: ['theme'],
  queryFn: () => getThemeFn(),
});
