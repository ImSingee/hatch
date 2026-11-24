/**
 * The platform event stream's context and subscriber hooks, without the
 * provider (which owns the stream and the query client), so components that
 * only subscribe stay free of server-function imports.
 */
import { createContext, useContext, useEffect } from 'react';
import { useEventCallback } from '~hooks/use-latest-committed';
import type { PlatformEvent } from '~server/platform-events';

type PlatformEventType = PlatformEvent['type'];
type PlatformEventFor<TType extends PlatformEventType> = Extract<
  PlatformEvent,
  { type: TType }
>;
export type PlatformEventListener = (event: PlatformEvent) => void;
export type ResyncListener = () => void;

export type PlatformEventsContextValue = {
  subscribe: (listener: PlatformEventListener) => () => void;
  subscribeResync: (listener: ResyncListener) => () => void;
};

export const PlatformEventsContext =
  createContext<PlatformEventsContextValue | null>(null);

function usePlatformEventsContext() {
  const context = useContext(PlatformEventsContext);
  if (!context) {
    throw new Error(
      'Platform event hooks must be used within PlatformEventsProvider.',
    );
  }
  return context;
}

/** Subscribe to one domain event type without re-rendering unrelated consumers. */
export function usePlatformEvent<TType extends PlatformEventType>(
  type: TType,
  listener: (event: PlatformEventFor<TType>) => void,
) {
  const { subscribe } = usePlatformEventsContext();
  const onEvent = useEventCallback(listener);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === type) {
          onEvent(event as PlatformEventFor<TType>);
        }
      }),
    [onEvent, subscribe, type],
  );
}

/**
 * Like {@link usePlatformEvent}, for components that may render outside the
 * authenticated shell (where there is no event stream): there it does
 * nothing.
 */
export function useOptionalPlatformEvent<TType extends PlatformEventType>(
  type: TType,
  listener: (event: PlatformEventFor<TType>) => void,
) {
  const context = useContext(PlatformEventsContext);
  const onEvent = useEventCallback(listener);

  useEffect(
    () =>
      context?.subscribe((event) => {
        if (event.type === type) {
          onEvent(event as PlatformEventFor<TType>);
        }
      }),
    [context, onEvent, type],
  );
}

/** Re-read durable state after the SSE stream connects or reconnects. */
export function usePlatformResync(listener: ResyncListener) {
  const { subscribeResync } = usePlatformEventsContext();
  const onResync = useEventCallback(listener);

  useEffect(() => subscribeResync(onResync), [onResync, subscribeResync]);
}
