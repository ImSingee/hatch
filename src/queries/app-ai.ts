import { queryOptions } from '@tanstack/react-query';
import {
  getAppAiDefaultsFn,
  getAppAiFn,
  listAppAiUsageFn,
} from '~server/app-ai';

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

/** The default chat and image models for Apps (Settings · Providers). */
export const appAiDefaultsQueryOptions = queryOptions({
  queryKey: ['app-ai-defaults'],
  queryFn: () => getAppAiDefaultsFn(),
});
