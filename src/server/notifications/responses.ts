/**
 * Answers to notification reply forms.
 *
 * Each round of a notification's reply form takes one answer, from whoever
 * answers first, and the answer never changes. An edit that asks a new
 * question starts the next round. Answering bumps the notification's revision so phones that
 * show it replace it with the answered state, and queues one delivery of the
 * answer to every destination a response route selects.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { db, schema, type TX } from '~/db';
import type { NotificationResponseVia } from '~/db/schema';
import { AppError } from '~server/errors';
import { readCappedText } from '~server/http-body';
import { publishPlatformEvent } from '~server/platform-events';
import {
  ReplyAnswerError,
  validateAnswers,
  type ReplyAnswers,
} from '../../../packages/hatch-platform-api/notification-reply';
import { wakeNotificationDispatcher } from './dispatcher';
import type { NotificationSource } from './ingest';
import { agentAnswerTargets } from './agent-answers';
import { requeueDelivered } from './lifecycle';
import { decryptDeviceKey } from './secrets';

export type NotificationResponseView = {
  /** The round of the reply form this answers. */
  round: number;
  answers: ReplyAnswers;
  respondedBy: { userId: string | null; name: string };
  via: NotificationResponseVia;
  /** Device that answered from the push itself. */
  destinationId: string | null;
  respondedAt: string;
};

export function responseView(
  row: typeof schema.notificationResponses.$inferSelect,
): NotificationResponseView {
  return {
    round: row.round,
    answers: row.answers,
    respondedBy: { userId: row.respondedByUserId, name: row.respondedByName },
    via: row.via,
    destinationId: row.destinationId,
    respondedAt: row.createdAt.toISOString(),
  };
}

/** The answer to one round of a notification's reply form. */
export async function loadResponseView(
  notificationId: string,
  round: number,
): Promise<NotificationResponseView | null> {
  const row = await db.query.notificationResponses.findFirst({
    where: { notificationId, round },
  });
  return row ? responseView(row) : null;
}

/** Every answer a notification took, oldest round first. */
export async function loadResponseHistory(
  notificationId: string,
  rounds: { from: number; to?: number } = { from: 1 },
): Promise<NotificationResponseView[]> {
  const rows = await db.query.notificationResponses.findMany({
    where: {
      notificationId,
      round:
        rounds.to === undefined
          ? { gte: rounds.from }
          : { gte: rounds.from, lte: rounds.to },
    },
    orderBy: { round: 'asc' },
  });
  return rows.map(responseView);
}

/**
 * The answers to the current round of several notifications, keyed by
 * notification id.
 */
export async function loadResponseViews(
  notifications: { id: string; replyRound: number }[],
): Promise<Map<string, NotificationResponseView>> {
  if (notifications.length === 0) return new Map();
  const current = new Map(notifications.map((n) => [n.id, n.replyRound]));
  const rows = await db.query.notificationResponses.findMany({
    where: { notificationId: { in: [...current.keys()] } },
  });
  return new Map(
    rows
      .filter((row) => current.get(row.notificationId) === row.round)
      .map((row) => [row.notificationId, responseView(row)]),
  );
}

/** Someone answered first; carries their answer. */
export class AlreadyRespondedError extends AppError {
  readonly response: NotificationResponseView;

  constructor(response: NotificationResponseView) {
    super(
      `This notification was already answered by ${response.respondedBy.name}.`,
      409,
      {
        code: 'notifications.alreadyAnswered',
        params: { name: response.respondedBy.name },
      },
    );
    this.name = 'AlreadyRespondedError';
    this.response = response;
  }
}

type RoutedResponseTarget = {
  id: string;
  type: 'webhook' | 'app';
  name: string;
  routeIds: string[];
};

/** An enabled response route that hands answers to the Agent. */
export type AgentResponseRoute = {
  id: string;
  /** The chat every answer goes to; null for one chat per notification. */
  agentSessionId: string | null;
  agentInstructions: string | null;
};

/**
 * Where answers to a notification from `source` of `kind` go: webhook and
 * App destinations, and Agent routes. Disabled routes and destinations never
 * match, and an App destination must still declare that it accepts
 * responses.
 */
export async function resolveResponseTargets(
  tx: TX,
  source:
    | Pick<Extract<NotificationSource, { type: 'app' }>, 'type' | 'appId'>
    | Pick<
        Extract<NotificationSource, { type: 'channel' }>,
        'type' | 'channelId'
      >
    | { type: 'platform' },
  kind: string,
): Promise<{
  destinations: RoutedResponseTarget[];
  agents: AgentResponseRoute[];
}> {
  if (source.type === 'platform') return { destinations: [], agents: [] };
  const matching = (
    await tx.query.notificationResponseRoutes.findMany({
      where: { enabled: true },
    })
  ).filter((route) => {
    if (route.kind !== null && route.kind !== kind) return false;
    if (route.sourceType === 'any') return true;
    if (route.sourceType !== source.type) return false;
    if (source.type === 'app') {
      return route.appId === null || route.appId === source.appId;
    }
    return route.channelId === null || route.channelId === source.channelId;
  });
  const agents = matching
    .filter((route) => route.targetType === 'agent')
    .map((route) => ({
      id: route.id,
      agentSessionId: route.agentSessionId,
      agentInstructions: route.agentInstructions,
    }));
  const routeIds = new Map<string, string[]>();
  for (const route of matching) {
    if (route.targetType !== 'destination' || !route.targetDestinationId) {
      continue;
    }
    const list = routeIds.get(route.targetDestinationId) ?? [];
    list.push(route.id);
    routeIds.set(route.targetDestinationId, list);
  }
  if (routeIds.size === 0) return { destinations: [], agents };
  const destinations = await tx.query.notificationDestinations.findMany({
    where: { id: { in: [...routeIds.keys()] }, enabled: true },
    columns: { id: true, type: true, name: true, acceptsResponses: true },
  });
  return {
    destinations: destinations.flatMap((destination) =>
      destination.type === 'webhook' ||
      (destination.type === 'app' && destination.acceptsResponses)
        ? [
            {
              id: destination.id,
              type: destination.type,
              name: destination.name,
              routeIds: [...(routeIds.get(destination.id) ?? [])].sort(),
            },
          ]
        : [],
    ),
    agents,
  };
}

export type Responder = {
  /** Null for the platform Agent, which answers with a Run credential. */
  userId: string | null;
  /** Shown when there is no user; a user's own name is looked up. */
  name?: string;
  via: NotificationResponseVia;
  /** Device that answered from the push. */
  destinationId?: string;
};

async function responderName(tx: TX, responder: Responder): Promise<string> {
  const { userId } = responder;
  if (!userId) return responder.name?.trim() || 'Someone';
  const user = await tx.query.user.findFirst({
    where: { id: userId },
    columns: { name: true, email: true },
  });
  return user?.name?.trim() || user?.email || 'Someone';
}

/** The reply form an answer was given on. */
export type ShownForm = { round: number } | { revision: number };

/**
 * Record the answer. Fails with 404 for a missing notification, 400 for a
 * notification without a form or answers that do not fit it, 409 when it
 * was recalled or asked a new question since the form was shown, and
 * `AlreadyRespondedError` (409) when someone answered first.
 *
 * `shown` names the form the person saw: its round, or the revision a phone
 * last received. An edit can ask a new question that keeps the old field and
 * option ids, so answers alone cannot tell which question they answer; a
 * stale form is refused instead of answering the new one.
 */
export async function respondToNotification(
  notificationId: string,
  answers: unknown,
  responder: Responder,
  shown?: ShownForm,
): Promise<NotificationResponseView> {
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    const [notification] = await tx
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notificationId))
      .for('update');
    if (!notification) {
      throw new AppError('Notification not found.', 404, {
        code: 'notifications.notificationNotFound',
      });
    }
    // A form shown before the sender changed or removed it is a conflict,
    // checked before whether there is a form to answer at all.
    const shownRound =
      shown === undefined
        ? notification.replyRound
        : 'round' in shown
          ? shown.round
          : await roundAtRevision(tx, notificationId, shown.revision);
    if (shownRound !== undefined && shownRound !== notification.replyRound) {
      throw new AppError(
        'The question changed since this form was shown; answer the current one.',
        409,
        { code: 'notifications.replyRoundChanged' },
      );
    }
    if (!notification.reply) {
      throw new AppError('This notification has no reply form.', 400, {
        code: 'notifications.noReplyForm',
      });
    }
    const currentRound = notification.replyRound;
    if (notification.respondedAt) {
      const existing = await tx.query.notificationResponses.findFirst({
        where: { notificationId, round: currentRound },
      });
      if (existing) throw new AlreadyRespondedError(responseView(existing));
    }
    if (notification.recalledAt) {
      throw new AppError('This notification was recalled.', 409, {
        code: 'notifications.recalled',
      });
    }
    let normalized: ReplyAnswers;
    try {
      normalized = validateAnswers(notification.reply, answers);
    } catch (error) {
      if (error instanceof ReplyAnswerError) {
        throw new AppError(error.message, 400);
      }
      throw error;
    }

    const [row] = await tx
      .insert(schema.notificationResponses)
      .values({
        notificationId,
        round: currentRound,
        revision: notification.revision + 1,
        answers: normalized,
        respondedByUserId: responder.userId,
        respondedByName: await responderName(tx, responder),
        via: responder.via,
        destinationId: responder.destinationId ?? null,
        createdAt: now,
      })
      .returning();
    await tx
      .update(schema.notifications)
      .set({
        respondedAt: now,
        revision: sql`${schema.notifications.revision} + 1`,
        responseRevision: sql`${schema.notifications.revision} + 1`,
      })
      .where(eq(schema.notifications.id, notificationId));
    // Phones replace the shown notification with the answered one. Webhooks
    // and Apps learn of the answer only through response routes.
    await requeueDelivered(tx, notificationId, now, { devicesOnly: true });

    // Like routing, response routes apply to App and Channel notifications;
    // a member's direct notification keeps its answer in history only.
    const { destinations: targets, agents } = await resolveResponseTargets(
      tx,
      notification.sourceType === 'app' && notification.appId
        ? { type: 'app', appId: notification.appId }
        : notification.sourceType === 'channel' && notification.channelId
          ? { type: 'channel', channelId: notification.channelId }
          : { type: 'platform' },
      notification.kind,
    );
    // The Agent hears about the answer as a message in a chat: the one that
    // asked, and those Agent routes pick. Each chat is a delivery of its own,
    // so one that fails never holds back the others and can be retried.
    const chats = agentAnswerTargets(notification, responder.userId, agents);
    const chatTitles = new Map(
      (
        await tx.query.agentSessions.findMany({
          where: {
            id: {
              in: chats.flatMap((chat) =>
                chat.agentSessionId ? [chat.agentSessionId] : [],
              ),
            },
          },
          columns: { id: true, title: true },
        })
      ).map((session) => [session.id, session.title]),
    );
    const deliveries = [
      ...targets.map((target) => ({
        destinationId: target.id,
        destinationType: target.type,
        destinationName: target.name,
        routeIds: target.routeIds,
      })),
      ...chats.map((chat) => ({
        destinationId: null,
        destinationType: 'agent' as const,
        // The notification's own chat is named after it.
        destinationName:
          (chat.agentSessionId
            ? chatTitles.get(chat.agentSessionId)
            : notification.title) || notification.title,
        agentSessionId: chat.agentSessionId,
        agentInstructions: chat.instructions,
        routeIds: chat.routeIds,
      })),
    ];
    if (deliveries.length > 0) {
      await tx.insert(schema.notificationResponseDeliveries).values(
        deliveries.map((delivery) => ({
          ...delivery,
          notificationId,
          round: currentRound,
          nextAttemptAt: now,
        })),
      );
    }
    return responseView(row!);
  });
  publishPlatformEvent({ type: 'notification.updated', notificationId });
  wakeNotificationDispatcher();
  return outcome;
}

/** ================== answers signed by a device ================== */

export const DEVICE_KID_HEADER = 'x-hatch-kid';
export const DEVICE_RESPONSE_MAX_BYTES = 16 * 1024;
const DEVICE_RESPONSE_MAX_SKEW_MS = 5 * 60_000;
const DEVICE_RESPONSE_INFO = 'hatch-response-v1';

/** Key the phone derives from its push key to sign answers (HKDF-SHA256). */
export function deviceResponseKey(deviceKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', deviceKey, Buffer.alloc(0), DEVICE_RESPONSE_INFO, 32),
  );
}

/** Base64 HMAC-SHA256 over `hatch-response-v1|<timestamp>|<body>`. */
export function deviceResponseSignature(
  deviceKey: Buffer,
  timestamp: string,
  body: string,
): string {
  return createHmac('sha256', deviceResponseKey(deviceKey))
    .update(`${DEVICE_RESPONSE_INFO}|${timestamp}|${body}`)
    .digest('base64');
}

export class DeviceResponseError extends AppError {}

/**
 * Accept an answer a phone sends straight from the push, while the app may
 * be running in the background without the user's session. The phone signs
 * it with its push key; the answer counts as the device owner's and only for
 * notifications this device received.
 */
export async function respondFromDevice(args: {
  kid: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  now?: number;
}): Promise<NotificationResponseView> {
  const { kid, timestamp, signature, body } = args;
  if (!kid || !timestamp || !signature) {
    throw new DeviceResponseError('Missing signature headers.', 401);
  }
  const sentAt = Number(timestamp);
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs((args.now ?? Date.now()) - sentAt) > DEVICE_RESPONSE_MAX_SKEW_MS
  ) {
    throw new DeviceResponseError('Signature timestamp is out of range.', 401);
  }
  const device = await db.query.notificationDestinations.findFirst({
    where: { type: 'device', e2eKeyId: kid },
  });
  if (!device?.e2eKeyCiphertext || !device.userId) {
    throw new DeviceResponseError('Unknown device.', 401);
  }
  const expected = Buffer.from(
    deviceResponseSignature(
      decryptDeviceKey(device.id, device.e2eKeyCiphertext),
      timestamp,
      body,
    ),
  );
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new DeviceResponseError('Invalid signature.', 401);
  }
  if (!device.enabled) {
    throw new DeviceResponseError('This device is turned off.', 403);
  }
  // Expired sessions linger until the hourly prune; their keys answer nothing.
  const session = device.sessionId
    ? await db.query.session.findFirst({
        where: { id: device.sessionId },
        columns: { expiresAt: true },
      })
    : undefined;
  if (!session || session.expiresAt.getTime() <= (args.now ?? Date.now())) {
    throw new DeviceResponseError('This device is no longer signed in.', 403);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('Body must be JSON.', 400);
  }
  const notificationId =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { notificationId?: unknown }).notificationId
      : undefined;
  if (typeof notificationId !== 'string') {
    throw new AppError('notificationId is required.', 400);
  }
  // Only a notification this device received; anything else looks missing.
  const received = await db
    .select({ revision: schema.notificationDeliveries.deliveredRevision })
    .from(schema.notificationDeliveries)
    .where(
      and(
        eq(schema.notificationDeliveries.notificationId, notificationId),
        eq(schema.notificationDeliveries.destinationId, device.id),
        isNotNull(schema.notificationDeliveries.deliveredRevision),
        ne(schema.notificationDeliveries.status, 'canceled'),
      ),
    )
    .limit(1);
  if (received.length === 0) {
    throw new AppError('Notification not found.', 404);
  }
  // The action answers the version its notification showed: the revision
  // the phone sends with it. App builds from before reply rounds send none,
  // and the delivery record cannot tell which version they showed (it moves
  // on when a newer push arrives), so theirs answer only the first question:
  // after a new one they are refused, and the person answers in the app.
  // The delivery record only proves eligibility above.
  const shown = (parsed as { revision?: unknown }).revision;
  if (
    shown !== undefined &&
    !(typeof shown === 'number' && Number.isInteger(shown) && shown > 0)
  ) {
    throw new AppError('revision must be a positive integer.', 400);
  }
  return respondToNotification(
    notificationId,
    (parsed as { answers?: unknown }).answers,
    { userId: device.userId, via: 'push', destinationId: device.id },
    shown === undefined ? { round: 1 } : { revision: shown },
  );
}

/**
 * The reply round a notification was in at `revision`. Rounds change only
 * with an edit, and every edit keeps the version it replaced, so the first
 * kept version at or after `revision` was still in that round; without one,
 * nothing has changed the round since.
 */
async function roundAtRevision(
  tx: TX,
  notificationId: string,
  revision: number,
): Promise<number | undefined> {
  const kept = await tx.query.notificationRevisions.findFirst({
    where: { notificationId, revision: { gte: revision } },
    orderBy: { revision: 'asc' },
    columns: { replyRound: true },
  });
  return kept?.replyRound;
}

/** HTTP handling of `POST /api/notifications/device-response`. */
export async function handleDeviceResponse(
  request: Request,
): Promise<Response> {
  // Stop reading at the limit: the body arrives before it is authenticated.
  const body = await readCappedText(request, DEVICE_RESPONSE_MAX_BYTES);
  if (body === null) {
    return new Response('Payload too large', { status: 413 });
  }
  try {
    const response = await respondFromDevice({
      kid: request.headers.get(DEVICE_KID_HEADER),
      timestamp: request.headers.get('x-hatch-timestamp'),
      signature: request.headers.get('x-hatch-signature'),
      body,
    });
    return Response.json({ ok: true, response });
  } catch (error) {
    if (error instanceof AlreadyRespondedError) {
      return Response.json(
        {
          ok: false,
          error: { code: 'ALREADY_RESPONDED', message: error.message },
          response: error.response,
        },
        { status: 409 },
      );
    }
    if (error instanceof AppError) {
      return Response.json(
        {
          ok: false,
          error: {
            code:
              error.code === 'notifications.replyRoundChanged'
                ? 'QUESTION_CHANGED'
                : error.status === 409
                  ? 'RECALLED'
                  : error.status === 404
                    ? 'NOT_FOUND'
                    : error.status === 401 || error.status === 403
                      ? 'UNAUTHORIZED'
                      : 'BAD_REQUEST',
            message: error.message,
          },
        },
        { status: error.status },
      );
    }
    throw error;
  }
}
