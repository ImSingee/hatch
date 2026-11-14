/**
 * Edits and recalls of a notification by the App or Channel that sent it.
 *
 * Each one increments the notification's revision. Deliveries record the
 * revision they last delivered, so the dispatcher sends every destination
 * that already has the notification one event for the latest state: edits
 * made in quick succession collapse into one, events to one destination never
 * overtake each other, and the usual retries apply. A destination that never
 * received a recalled notification never receives its content.
 */
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { db, schema, type TX } from '~/db';
import { publishPlatformEvent } from '~server/platform-events';
import type { NotificationUpdate } from './contract';
import { wakeNotificationDispatcher } from './dispatcher';

export type NotificationSender =
  | { type: 'app'; appId: string }
  | { type: 'channel'; channelId: string };

export type LifecycleResult = {
  id: string;
  revision: number;
  recalled: boolean;
};

export class NotificationLifecycleError extends Error {
  readonly status: 404 | 409 | 400;

  constructor(message: string, status: 404 | 409 | 400) {
    super(message);
    this.name = 'NotificationLifecycleError';
    this.status = status;
  }
}

type LockedNotification = typeof schema.notifications.$inferSelect;

/**
 * Lock the sender's own notification. Another source's notification is
 * reported exactly like a missing one.
 */
async function lockOwnNotification(
  tx: TX,
  sender: NotificationSender,
  id: string,
): Promise<LockedNotification> {
  const notifications = schema.notifications;
  const [row] = await tx
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.id, id),
        sender.type === 'app'
          ? and(
              eq(notifications.sourceType, 'app'),
              eq(notifications.appId, sender.appId),
            )
          : and(
              eq(notifications.sourceType, 'channel'),
              eq(notifications.channelId, sender.channelId),
            ),
      ),
    )
    .for('update');
  if (!row) throw new NotificationLifecycleError('Notification not found', 404);
  return row;
}

/**
 * Queue the new revision for every destination that already received the
 * notification and takes edit and recall events. Deliveries in progress are
 * left alone: their outcome sees the newer revision and re-queues itself.
 */
async function requeueDelivered(tx: TX, notificationId: string, now: Date) {
  const deliveries = schema.notificationDeliveries;
  const destinations = schema.notificationDestinations;
  const takesEvents = tx
    .select({ id: destinations.id })
    .from(destinations)
    .where(
      and(
        eq(destinations.enabled, true),
        or(
          eq(destinations.type, 'device'),
          eq(destinations.lifecycleEvents, true),
        ),
      ),
    );
  await tx
    .update(deliveries)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseExpiresAt: null,
      completedAt: null,
      lastError: null,
      httpStatus: null,
    })
    .where(
      and(
        eq(deliveries.notificationId, notificationId),
        isNotNull(deliveries.deliveredRevision),
        ne(deliveries.status, 'in_progress'),
        inArray(deliveries.destinationId, takesEvents),
      ),
    );
}

function publishChange(id: string) {
  publishPlatformEvent({ type: 'notification.updated', notificationId: id });
  wakeNotificationDispatcher();
}

/** Apply an edit; unchanged content leaves the revision as it is. */
export async function updateNotification(
  sender: NotificationSender,
  update: NotificationUpdate,
): Promise<LifecycleResult> {
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const current = await lockOwnNotification(tx, sender, update.id);
    if (current.recalledAt) {
      throw new NotificationLifecycleError(
        'A recalled notification cannot be edited',
        409,
      );
    }
    const next = {
      title: update.title ?? current.title,
      body: update.body === undefined ? current.body : update.body,
      url: update.url === undefined ? current.url : update.url,
      autoOpenUrl:
        update.autoOpenUrl === undefined
          ? current.autoOpenUrl
          : update.autoOpenUrl,
      data: update.data === undefined ? current.data : update.data,
    };
    // Without an explicit choice, a link follows the push default: a new
    // link opens on tap, a cleared one stops, a replaced one keeps the setting.
    if (update.url !== undefined && update.autoOpenUrl === undefined) {
      next.autoOpenUrl =
        next.url !== null && (current.url === null || current.autoOpenUrl);
    }
    if (next.autoOpenUrl && !next.url) {
      throw new NotificationLifecycleError('autoOpenUrl requires url', 400);
    }
    const changed =
      next.title !== current.title ||
      next.body !== current.body ||
      next.url !== current.url ||
      next.autoOpenUrl !== current.autoOpenUrl ||
      JSON.stringify(next.data) !== JSON.stringify(current.data);
    if (!changed) {
      return { id: current.id, revision: current.revision, changed: false };
    }
    const [row] = await tx
      .update(schema.notifications)
      .set({
        ...next,
        revision: sql`${schema.notifications.revision} + 1`,
        editedAt: now,
      })
      .where(eq(schema.notifications.id, current.id))
      .returning({ revision: schema.notifications.revision });
    await requeueDelivered(tx, current.id, now);
    return { id: current.id, revision: row!.revision, changed: true };
  });
  if (outcome.changed) publishChange(outcome.id);
  return { id: outcome.id, revision: outcome.revision, recalled: false };
}

/** Recall a notification; repeating a recall changes nothing. */
export async function recallNotification(
  sender: NotificationSender,
  id: string,
): Promise<LifecycleResult> {
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const current = await lockOwnNotification(tx, sender, id);
    if (current.recalledAt) {
      return { revision: current.revision, changed: false };
    }
    const [row] = await tx
      .update(schema.notifications)
      .set({
        revision: sql`${schema.notifications.revision} + 1`,
        recalledAt: now,
      })
      .where(eq(schema.notifications.id, id))
      .returning({ revision: schema.notifications.revision });
    // Destinations that never received it never will.
    const deliveries = schema.notificationDeliveries;
    await tx
      .update(deliveries)
      .set({
        status: 'canceled',
        leaseExpiresAt: null,
        completedAt: now,
      })
      .where(
        and(
          eq(deliveries.notificationId, id),
          isNull(deliveries.deliveredRevision),
          inArray(deliveries.status, ['pending', 'failed']),
        ),
      );
    await requeueDelivered(tx, id, now);
    return { revision: row!.revision, changed: true };
  });
  if (outcome.changed) publishChange(id);
  return { id, revision: outcome.revision, recalled: true };
}
