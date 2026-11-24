import { queryOptions } from '@tanstack/react-query';
import { getServerInfoFn } from '~server/server-info';

export const serverInfoQueryOptions = queryOptions({
  queryKey: ['server-info'],
  queryFn: () => getServerInfoFn(),
});
