import { queryOptions } from '@tanstack/react-query';
import { getImageModelFn } from '~server/app-icons';

export const imageModelQueryOptions = queryOptions({
  queryKey: ['agent', 'image-model'],
  queryFn: () => getImageModelFn(),
});
