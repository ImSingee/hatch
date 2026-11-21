import { queryOptions } from '@tanstack/react-query';
import { getImageModelFn } from '~server/app-icons';
import { providersQueryOptions } from './agent';

export const imageModelQueryOptions = queryOptions({
  // Nested under the providers key: which providers can generate images and
  // whether the selection is usable both change with every provider mutation,
  // so invalidating providers must refetch this too.
  queryKey: [...providersQueryOptions.queryKey, 'image-model'],
  queryFn: () => getImageModelFn(),
});
