import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { themeQueryOptions } from '~queries/theme';
import type { PlatformEvent } from '~server/platform-events';
import {
  PlatformEventsContext,
  type PlatformEventListener,
  type PlatformEventsContextValue,
  type ResyncListener,
} from './platform-events-context';

export {
  useOptionalPlatformEvent,
  usePlatformEvent,
  usePlatformResync,
} from './platform-events-context';

function stringField(value: object, key: string): string | null {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

function parsePlatformEvent(message: MessageEvent<string>) {
  try {
    const value: unknown = JSON.parse(message.data);
    if (typeof value !== 'object' || value === null) return null;
    const type = stringField(value, 'type');
    if (type === 'app.deployment.activated') {
      const appId = stringField(value, 'appId');
      const deploymentRevision = stringField(value, 'deploymentRevision');
      if (!appId || !deploymentRevision) return null;
      return { type, appId, deploymentRevision } satisfies PlatformEvent;
    }
    if (
      type === 'notification.created' ||
      type === 'notification.updated' ||
      type === 'notification.deleted'
    ) {
      const notificationId = stringField(value, 'notificationId');
      if (!notificationId) return null;
      return { type, notificationId } satisfies PlatformEvent;
    }
    if (type === 'notification.delivery.updated') {
      const notificationId = stringField(value, 'notificationId');
      const deliveryId = stringField(value, 'deliveryId');
      if (!notificationId || !deliveryId) return null;
      return { type, notificationId, deliveryId } satisfies PlatformEvent;
    }
    if (type === 'theme.updated') {
      const accent = stringField(value, 'accent');
      if (!accent) return null;
      return { type, accent } satisfies PlatformEvent;
    }
    if (type === 'pins.updated') return { type } satisfies PlatformEvent;
    if (type === 'dashboards.updated')
      return {
        type,
        dashboardId: stringField(value, 'dashboardId') ?? undefined,
      } satisfies PlatformEvent;
    return null;
  } catch {
    return null;
  }
}

/** Owns the authenticated app shell's single platform-wide SSE connection. */
export function PlatformEventsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const listeners = useRef(new Set<PlatformEventListener>());
  const resyncListeners = useRef(new Set<ResyncListener>());
  const queryClient = useQueryClient();
  const context = useMemo<PlatformEventsContextValue>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      subscribeResync(listener) {
        resyncListeners.current.add(listener);
        return () => resyncListeners.current.delete(listener);
      },
    }),
    [],
  );

  useEffect(() => {
    const source = new EventSource('/api/events');
    const onPlatformEvent = (rawEvent: Event) => {
      const event = parsePlatformEvent(rawEvent as MessageEvent<string>);
      if (!event) return;
      // The theme is applied above every route, outside this provider, so it
      // is refreshed here instead of through a subscriber.
      if (event.type === 'theme.updated')
        void queryClient.invalidateQueries({
          queryKey: themeQueryOptions.queryKey,
        });
      for (const listener of listeners.current) listener(event);
    };
    const onResync = () => {
      void queryClient.invalidateQueries({
        queryKey: themeQueryOptions.queryKey,
      });
      for (const listener of resyncListeners.current) listener();
    };

    source.addEventListener('platform', onPlatformEvent);
    source.addEventListener('resync', onResync);

    return () => {
      source.removeEventListener('platform', onPlatformEvent);
      source.removeEventListener('resync', onResync);
      source.close();
    };
  }, [queryClient]);

  return (
    <PlatformEventsContext.Provider value={context}>
      {children}
    </PlatformEventsContext.Provider>
  );
}
