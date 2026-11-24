/** Events broadcast by the Platform process to connected browser clients. */
export type PlatformEvent =
  | {
      type: 'app.deployment.activated';
      appId: string;
      deploymentRevision: string;
    }
  | { type: 'notification.created'; notificationId: string }
  /** The source edited or recalled the notification. */
  | { type: 'notification.updated'; notificationId: string }
  /** A member deleted the notification from history. */
  | { type: 'notification.deleted'; notificationId: string }
  | {
      type: 'notification.delivery.updated';
      notificationId: string;
      deliveryId: string;
    }
  /** The instance theme changed; clients re-read it. */
  | { type: 'theme.updated'; accent: string }
  /** App or dashboard pins changed; clients re-read them. */
  | { type: 'pins.updated' }
  /**
   * A dashboard, its settings or its widgets changed; clients re-read it.
   * Without an id, every dashboard may have changed.
   */
  | { type: 'dashboards.updated'; dashboardId?: string };

export type PlatformEventSubscriber = (event: PlatformEvent) => void;

type PlatformEventsGlobal = typeof globalThis & {
  __hatchPlatformEventSubscribers__?: Set<PlatformEventSubscriber>;
};

function subscribers(): Set<PlatformEventSubscriber> {
  const global = globalThis as PlatformEventsGlobal;
  global.__hatchPlatformEventSubscribers__ ??=
    new Set<PlatformEventSubscriber>();
  return global.__hatchPlatformEventSubscribers__;
}

/**
 * Publish a transient Platform event to every subscriber in this process.
 *
 * Subscriber failures are isolated so a disconnected stream (or a future
 * faulty subscriber) can never turn a successful domain operation into a
 * failure. Events are deliberately not persisted; clients resync from the
 * database whenever their SSE connection is established.
 */
export function publishPlatformEvent(event: PlatformEvent): void {
  for (const subscriber of subscribers()) {
    try {
      subscriber(event);
    } catch (error) {
      console.error('Platform event subscriber failed.', error);
    }
  }
}

/** Subscribe to Platform events until the returned function is called. */
export function subscribePlatformEvents(
  subscriber: PlatformEventSubscriber,
): () => void {
  const currentSubscribers = subscribers();
  currentSubscribers.add(subscriber);
  return () => {
    currentSubscribers.delete(subscriber);
  };
}
