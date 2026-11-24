import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { NotificationSourceType } from '~/db/schema';
import {
  getApnsStatusFn,
  getNotificationFn,
  listChannelsFn,
  listDestinationsFn,
  listGroupsFn,
  listNotificationSourcesFn,
  listNotificationsFn,
  listResponseRoutesFn,
  listRoutesFn,
  type NotificationReplyState,
  type NotificationStatus,
} from '~server/notifications';

/** Root key: invalidating it refreshes every notification view. */
export const NOTIFICATIONS_KEY = ['notifications'] as const;

export type NotificationFilters = {
  sourceType?: NotificationSourceType;
  sourceId?: string;
  kind?: string;
  status?: NotificationStatus;
  replyState?: NotificationReplyState;
};

export const notificationHistoryQueryOptions = (filters: NotificationFilters) =>
  infiniteQueryOptions({
    queryKey: [...NOTIFICATIONS_KEY, 'history', filters],
    queryFn: ({ pageParam }) =>
      listNotificationsFn({
        data: { ...filters, cursor: pageParam ?? undefined, limit: 50 },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

export const notificationDetailQueryOptions = (id: string) =>
  queryOptions({
    queryKey: [...NOTIFICATIONS_KEY, 'detail', id],
    queryFn: () => getNotificationFn({ data: id }),
  });

export const notificationSourcesQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'sources'],
  queryFn: () => listNotificationSourcesFn(),
});

export const notificationDestinationsQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'destinations'],
  queryFn: () => listDestinationsFn(),
});

export const notificationGroupsQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'groups'],
  queryFn: () => listGroupsFn(),
});

export const notificationRoutesQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'routes'],
  queryFn: () => listRoutesFn(),
});

export const notificationResponseRoutesQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'response-routes'],
  queryFn: () => listResponseRoutesFn(),
});

export const notificationChannelsQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'channels'],
  queryFn: () => listChannelsFn(),
});

export const apnsStatusQueryOptions = queryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'apns'],
  queryFn: () => getApnsStatusFn(),
});

/**
 * The timeline: newest activity first, so an edited notification comes back
 * at the top of the first page. The page shows it reversed, newest at the end.
 */
export const notificationTimelineQueryOptions = infiniteQueryOptions({
  queryKey: [...NOTIFICATIONS_KEY, 'timeline'],
  queryFn: ({ pageParam }) =>
    listNotificationsFn({
      data: { order: 'activity', cursor: pageParam ?? undefined, limit: 50 },
    }),
  initialPageParam: null as string | null,
  getNextPageParam: (page) => page.nextCursor,
});
