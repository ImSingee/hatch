import { queryOptions } from '@tanstack/react-query';
import { getImageModelFn, listAppIconsFn } from '~server/app-icons';

/** Icon key per App id; Apps without an icon are absent. */
export const appIconsQueryOptions = queryOptions({
  queryKey: ['apps', 'icons'],
  queryFn: () => listAppIconsFn(),
  staleTime: 30_000,
});

export const imageModelQueryOptions = queryOptions({
  queryKey: ['agent', 'image-model'],
  queryFn: () => getImageModelFn(),
});
