import { queryOptions } from '@tanstack/react-query';
import { getAppAiFn, listAppAiUsageFn } from '~server/app-ai';

export const appAiQueryOptions = (appId: string) =>
  queryOptions({
    queryKey: ['app-ai', appId],
    queryFn: () => getAppAiFn({ data: appId }),
  });

export const appAiUsageQueryOptions = (appId: string) =>
  queryOptions({
    queryKey: ['app-ai', appId, 'usage'],
    queryFn: () => listAppAiUsageFn({ data: { id: appId } }),
    refetchInterval: 30_000,
  });
