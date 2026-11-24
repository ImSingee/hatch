/**
 * Notification center management: history, destinations, groups, routes and
 * channels. Shared by Web Server Functions and the public Connect API, so all
 * validation and invariants live here.
 */
import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, schema, type TX } from '~/db';
import type {
  NotificationDeliveryStatus,
  NotificationDestinationType,
  NotificationKindDeclaration,
  NotificationRouteSourceType,
  NotificationResponseTargetType,
  NotificationSourceType,
} from '~/db/schema';
import { getPlatformEnv } from '~/env';
import type { NormalizedManifest } from '~server/apps/manifest';
import { getAgentModelCatalog } from '~server/agent-model-catalog';
import { AppError } from '~server/errors';
import { publishPlatformEvent } from '~server/platform-events';
import { describeApnsCredentials } from './apns/credentials';
import { channelPushPath } from './channel-ingress';
import {
  DEFAULT_NOTIFICATION_PRIORITY,
  NOTIFICATION_KIND_RE,
  channelKindsSchema,
  isHttpUrl,
  notificationPushSchema,
  notificationSourceId,
  notificationUpdateSchema,
  type NotificationPush,
  pushIssueMessage,
} from './contract';
import { ingestChannelPush } from './channel-ingress';
import type { ReplyForm } from '../../../packages/hatch-platform-api/notification-reply';
import type { NotificationCard } from '../../../packages/hatch-platform-api/notification-card';
import {
  ingestNotification,
  newNotificationId,
  type NotificationSource,
  type NotificationTarget,
  requeueDelivery,
  requeueResponseDelivery,
} from './ingest';
import {
  NotificationLifecycleError,
  recallNotification,
  updateNotification,
  type LifecycleResult,
} from './lifecycle';
import {
  loadResponseHistory,
  loadResponseView,
  loadResponseViews,
  type NotificationResponseView,
} from './responses';
import {
  encryptDeviceKey,
  encryptWebhookSecret,
  hashChannelToken,
  isValidDeviceKey,
  mintChannelToken,
  mintWebhookSecret,
} from './secrets';

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const LIST_LIMIT_MAX = 100;
const MAX_GROUP_MEMBERS = 200;

function cleanName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new AppError(`${label} is required.`, 400);
  if (name.length > NAME_MAX) {
    throw new AppError(`${label} must be at most ${NAME_MAX} characters.`, 400);
  }
  return name;
}

function cleanDescription(value: string | null | undefined): string | null {
  const description = value?.trim() ?? '';
  if (description.length > DESCRIPTION_MAX) {
    throw new AppError(
      `Description must be at most ${DESCRIPTION_MAX} characters.`,
      400,
    );
  }
  return description || null;
}

function cleanWebhookUrl(value: string): string {
  const url = value.trim();
  if (url.length > 2048 || !isHttpUrl(url)) {
    throw new AppError('Webhook URL must be an absolute http(s) URL.', 400);
  }
  return url;
}

function notFound(what: string): never {
  throw new AppError(`${what} not found.`, 404);
}

/** ================== read models ================== */

export type NotificationStatus =
  | 'unrouted'
  | 'pending'
  | 'delivered'
  | 'partial'
  | 'failed';

/** `canceled` deliveries (recalled before arriving) count as finished. */
export type DeliveryCounts = {
  pending: number;
  succeeded: number;
  failed: number;
  canceled: number;
};

export type NotificationSummaryView = {
  id: string;
  sourceType: NotificationSourceType;
  sourceId: string | null;
  sourceName: string;
  kind: string;
  kindName: string;
  title: string;
  body: string | null;
  url: string | null;
  autoOpenUrl: boolean;
  /** -2 lowest, -1 low, 0 normal, 1 high. */
  priority: number;
  occurredAt: string;
  createdAt: string;
  /**
   * When the source last pushed or edited it; the timeline's order. Answers
   * and recalls leave it unchanged.
   */
  activityAt: string;
  /** 1 for the original; every edit and the recall increment it. */
  revision: number;
  editedAt: string | null;
  recalledAt: string | null;
  /** Status and one block the timeline shows; null without one. */
  card: NotificationCard | null;
  /**
   * The question the notification asks now; null when it asks nothing. Each
   * round takes one answer.
   */
  reply: ReplyForm | null;
  /** Which question `reply` is: 1 for the form it was sent with. */
  replyRound: number;
  respondedAt: string | null;
  /** The answer to the current round; null until someone answers. */
  response: NotificationResponseView | null;
  status: NotificationStatus;
  deliveries: DeliveryCounts;
};

/**
 * `awaiting`: a reply form nobody answered yet (and not recalled);
 * `answered`: someone answered it.
 */
export type NotificationReplyState = 'awaiting' | 'answered';

export type DeliveryView = {
  id: string;
  destinationId: string | null;
  destinationType: NotificationDestinationType;
  destinationName: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  httpStatus: number | null;
  result: string | null;
  /** Revision this destination last received; null when it never did. */
  deliveredRevision: number | null;
  routeIds: string[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotificationDetailView = NotificationSummaryView & {
  data: Record<string, unknown> | null;
  dedupeKey: string | null;
  deliveryList: DeliveryView[];
  /** Deliveries of the answer to response route destinations. */
  responseDeliveryList: DeliveryView[];
};

export type DestinationView = {
  id: string;
  type: NotificationDestinationType;
  name: string;
  enabled: boolean;
  lastError: string | null;
  /** Receives edit and recall events (always true for devices). */
  lifecycleEvents: boolean;
  /**
   * Response routes may send it answers: every webhook, and an App whose
   * manifest accepts responses. Never a device.
   */
  acceptsResponses: boolean;
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
  device: {
    platform: string;
    environment: string;
    userId: string;
    userName: string | null;
    sessionId: string;
  } | null;
  webhook: { url: string } | null;
  app: {
    appId: string;
    slug: string | null;
    accepting: boolean;
  } | null;
};

export type GroupView = {
  id: string;
  name: string;
  description: string | null;
  /** New device destinations join the group when they are created. */
  autoAddDevices: boolean;
  destinationIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type RouteView = {
  id: string;
  name: string | null;
  sourceType: NotificationRouteSourceType;
  sourceId: string | null;
  kind: string | null;
  targetType: 'group' | 'destination';
  targetId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ResponseRouteView = {
  id: string;
  name: string | null;
  sourceType: NotificationRouteSourceType;
  sourceId: string | null;
  kind: string | null;
  /** `destination`: a webhook or App. `agent`: a message in an Agent chat. */
  targetType: NotificationResponseTargetType;
  /** The webhook or App, for a `destination` target. */
  destinationId: string | null;
  /** For an `agent` target: its chat, or null for one chat per notification. */
  agentSessionId: string | null;
  /** For an `agent` target: what the Agent should do with each answer. */
  agentInstructions: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChannelView = {
  id: string;
  name: string;
  description: string | null;
  kinds: NotificationKindDeclaration[];
  enabled: boolean;
  pushUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type NotificationSourcesView = {
  apps: {
    id: string;
    slug: string;
    name: string;
    kinds: NotificationKindDeclaration[];
  }[];
  channels: {
    id: string;
    name: string;
    kinds: NotificationKindDeclaration[];
  }[];
  /**
   * Kinds of retained notifications people sent straight to a group or
   * destination. They are free labels, so only stored history knows them.
   */
  userKinds: NotificationKindDeclaration[];
};

export type ApnsStatusView = ReturnType<typeof describeApnsCredentials>;

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

function deliveryStatus(counts: DeliveryCounts): NotificationStatus {
  const finished = counts.succeeded + counts.canceled;
  if (counts.pending + finished + counts.failed === 0) return 'unrouted';
  if (counts.pending > 0) return 'pending';
  if (counts.failed === 0) return 'delivered';
  if (finished === 0) return 'failed';
  return 'partial';
}

async function deliveryCounts(
  notificationIds: string[],
): Promise<Map<string, DeliveryCounts>> {
  const counts = new Map<string, DeliveryCounts>();
  if (notificationIds.length === 0) return counts;
  const rows = await db
    .select({
      notificationId: schema.notificationDeliveries.notificationId,
      status: schema.notificationDeliveries.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.notificationDeliveries)
    .where(
      inArray(schema.notificationDeliveries.notificationId, notificationIds),
    )
    .groupBy(
      schema.notificationDeliveries.notificationId,
      schema.notificationDeliveries.status,
    );
  for (const row of rows) {
    const entry = counts.get(row.notificationId) ?? {
      pending: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
    };
    const count = Number(row.count);
    if (row.status === 'succeeded') entry.succeeded += count;
    else if (row.status === 'failed') entry.failed += count;
    else if (row.status === 'canceled') entry.canceled += count;
    else entry.pending += count;
    counts.set(row.notificationId, entry);
  }
  return counts;
}

type NotificationRow = typeof schema.notifications.$inferSelect;

function summaryView(
  row: NotificationRow,
  counts: DeliveryCounts | undefined,
  response: NotificationResponseView | null,
): NotificationSummaryView {
  const deliveries = counts ?? {
    pending: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
  };
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: notificationSourceId(row),
    sourceName: row.sourceName,
    kind: row.kind,
    kindName: row.kindName,
    title: row.title,
    body: row.body,
    url: row.url,
    autoOpenUrl: row.autoOpenUrl,
    priority: row.priority,
    occurredAt: iso(row.occurredAt),
    createdAt: iso(row.createdAt),
    activityAt: iso(row.activityAt),
    revision: row.revision,
    editedAt: isoOrNull(row.editedAt),
    recalledAt: isoOrNull(row.recalledAt),
    card: row.card,
    reply: row.reply,
    replyRound: row.replyRound,
    respondedAt: isoOrNull(row.respondedAt),
    response,
    status: deliveryStatus(deliveries),
    deliveries,
  };
}

/** ================== history ================== */

export type ListNotificationsInput = {
  sourceType?: NotificationSourceType;
  sourceId?: string;
  kind?: string;
  status?: NotificationStatus;
  replyState?: NotificationReplyState;
  /**
   * `created` (default): newest pushed first. `activity`: most recently
   * pushed or edited first, the timeline's order.
   */
  order?: NotificationListOrder;
  /** The `nextCursor` of the previous page, for the same `order`. */
  cursor?: string;
  limit?: number;
};

export type NotificationListOrder = 'created' | 'activity';

/**
 * An `activity` cursor names the last row of a page by its activity time and
 * id, since several notifications can share one activity time.
 */
function activityCursor(row: NotificationRow): string {
  return `${row.activityAt.getTime()}.${row.id}`;
}

function parseActivityCursor(cursor: string): { at: Date; id: string } {
  const match = /^(\d{1,15})\.([0-9A-Za-z]{26})$/.exec(cursor);
  if (!match) throw new AppError('Invalid cursor for activity order.', 400);
  return { at: new Date(Number(match[1])), id: match[2]! };
}

function statusFilter(status: NotificationStatus): SQL {
  const d = schema.notificationDeliveries;
  const n = schema.notifications;
  const deliveriesWith = (statuses: NotificationDeliveryStatus[] | null) =>
    db
      .select({ one: sql`1` })
      .from(d)
      .where(
        and(
          eq(d.notificationId, n.id),
          statuses ? inArray(d.status, statuses) : undefined,
        ),
      );
  switch (status) {
    case 'unrouted':
      return notExists(deliveriesWith(null));
    case 'pending':
      return exists(deliveriesWith(['pending', 'in_progress']));
    case 'delivered':
      return and(
        exists(deliveriesWith(null)),
        notExists(deliveriesWith(['pending', 'in_progress', 'failed'])),
      ) as SQL;
    case 'failed':
      return and(
        exists(deliveriesWith(['failed'])),
        notExists(
          deliveriesWith(['pending', 'in_progress', 'succeeded', 'canceled']),
        ),
      ) as SQL;
    case 'partial':
      return and(
        exists(deliveriesWith(['failed'])),
        exists(deliveriesWith(['succeeded', 'canceled'])),
        notExists(deliveriesWith(['pending', 'in_progress'])),
      ) as SQL;
  }
}

export async function listNotifications(
  input: ListNotificationsInput = {},
): Promise<{ items: NotificationSummaryView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit || 50, 1), LIST_LIMIT_MAX);
  const n = schema.notifications;
  const byActivity = input.order === 'activity';
  const after =
    byActivity && input.cursor ? parseActivityCursor(input.cursor) : null;
  const conditions: (SQL | undefined)[] = [
    input.sourceType ? eq(n.sourceType, input.sourceType) : undefined,
    input.sourceId
      ? sql`coalesce(${n.appId}, ${n.channelId}, ${n.userId}) = ${input.sourceId}`
      : undefined,
    input.kind ? eq(n.kind, input.kind) : undefined,
    after
      ? sql`(${n.activityAt}, ${n.id}) < (${after.at}, ${after.id})`
      : !byActivity && input.cursor
        ? lt(n.id, input.cursor)
        : undefined,
    input.status ? statusFilter(input.status) : undefined,
    input.replyState === 'awaiting'
      ? and(isNotNull(n.reply), isNull(n.respondedAt), isNull(n.recalledAt))
      : input.replyState === 'answered'
        ? isNotNull(n.respondedAt)
        : undefined,
  ];
  const rows = await db
    .select()
    .from(n)
    .where(and(...conditions))
    .orderBy(...(byActivity ? [desc(n.activityAt), desc(n.id)] : [desc(n.id)]))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.id);
  const [counts, responses] = await Promise.all([
    deliveryCounts(ids),
    loadResponseViews(page),
  ]);
  const last = page.at(-1);
  return {
    items: page.map((row) =>
      summaryView(row, counts.get(row.id), responses.get(row.id) ?? null),
    ),
    nextCursor:
      rows.length > limit && last
        ? byActivity
          ? activityCursor(last)
          : last.id
        : null,
  };
}

function deliveryView(
  row: Omit<
    typeof schema.notificationDeliveries.$inferSelect,
    'deliveredRevision'
  > & { deliveredRevision?: number | null },
): DeliveryView {
  return {
    id: row.id,
    destinationId: row.destinationId,
    destinationType: row.destinationType,
    destinationName: row.destinationName,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt:
      row.status === 'pending' || row.status === 'in_progress'
        ? iso(row.nextAttemptAt)
        : null,
    lastError: row.lastError,
    httpStatus: row.httpStatus,
    result: row.result,
    deliveredRevision: row.deliveredRevision ?? null,
    routeIds: row.routeIds,
    completedAt: isoOrNull(row.completedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function getNotification(
  id: string,
): Promise<NotificationDetailView> {
  const row = await db.query.notifications.findFirst({ where: { id } });
  if (!row) notFound('Notification');
  const [deliveries, responseDeliveries, response] = await Promise.all([
    db.query.notificationDeliveries.findMany({
      where: { notificationId: id },
      orderBy: { createdAt: 'asc' },
    }),
    db.query.notificationResponseDeliveries.findMany({
      where: { notificationId: id },
      orderBy: { createdAt: 'asc' },
    }),
    row.respondedAt
      ? loadResponseView(id, row.replyRound)
      : Promise.resolve(null),
  ]);
  const counts = (await deliveryCounts([id])).get(id);
  return {
    ...summaryView(row, counts, response),
    data: row.data,
    dedupeKey: row.dedupeKey,
    deliveryList: deliveries.map(deliveryView),
    responseDeliveryList: responseDeliveries.map(deliveryView),
  };
}

export type NotificationRevisionView = {
  /** The revision while this version was current. */
  revision: number;
  title: string;
  body: string | null;
  url: string | null;
  data: Record<string, unknown> | null;
  card: NotificationCard | null;
  reply: ReplyForm | null;
  replyRound: number;
  /** When this version became current. */
  activityAt: string;
  /** When an edit replaced it. */
  replacedAt: string;
};

/**
 * What a notification said before each edit, oldest first, and every answer
 * it took (one per round).
 */
export async function listNotificationRevisions(id: string): Promise<{
  revisions: NotificationRevisionView[];
  responses: NotificationResponseView[];
}> {
  const row = await db.query.notifications.findFirst({
    where: { id },
    columns: { id: true },
  });
  if (!row) notFound('Notification');
  const [revisions, responses] = await Promise.all([
    db.query.notificationRevisions.findMany({
      where: { notificationId: id },
      orderBy: { revision: 'asc' },
    }),
    loadResponseHistory(id),
  ]);
  return {
    revisions: revisions.map((revision) => ({
      revision: revision.revision,
      title: revision.title,
      body: revision.body,
      url: revision.url,
      data: revision.data,
      card: revision.card,
      reply: revision.reply,
      replyRound: revision.replyRound,
      activityAt: iso(revision.activityAt),
      replacedAt: iso(revision.replacedAt),
    })),
    responses,
  };
}

/** Retry a failed delivery of a notification or of its answer. */
export async function retryDelivery(deliveryId: string): Promise<void> {
  const delivery =
    (await db.query.notificationDeliveries.findFirst({
      where: { id: deliveryId },
      columns: { status: true, destinationId: true },
    })) ??
    (await db.query.notificationResponseDeliveries.findFirst({
      where: { id: deliveryId },
      columns: { status: true, destinationId: true },
    }));
  if (!delivery) notFound('Delivery');
  if (delivery.status !== 'failed') {
    throw new AppError('Only failed deliveries can be retried.', 409);
  }
  if (!delivery.destinationId) {
    throw new AppError('The destination of this delivery was removed.', 409);
  }
  if (
    !(await requeueDelivery(deliveryId)) &&
    !(await requeueResponseDelivery(deliveryId))
  ) {
    throw new AppError('Only failed deliveries can be retried.', 409);
  }
}

/** ================== sources ================== */

export async function listNotificationSources(): Promise<NotificationSourcesView> {
  const apps = await db.query.apps.findMany({
    where: { status: { ne: 'archived' } },
    columns: {
      id: true,
      slug: true,
      name: true,
      capabilities: true,
      currentDeploymentId: true,
    },
    orderBy: { name: 'asc' },
  });
  const candidates = apps.filter(
    (app) => app.capabilities?.notifications && app.currentDeploymentId,
  );
  const deployments =
    candidates.length === 0
      ? []
      : await db.query.deployments.findMany({
          where: {
            id: {
              in: candidates.map((app) => app.currentDeploymentId as string),
            },
          },
          columns: { id: true, manifestNormalized: true },
        });
  const manifests = new Map(
    deployments.map((deployment) => [
      deployment.id,
      deployment.manifestNormalized as NormalizedManifest | null,
    ]),
  );
  const channels = await db.query.notificationChannels.findMany({
    orderBy: { name: 'asc' },
  });
  const n = schema.notifications;
  const userKinds = await db
    .selectDistinct({ kind: n.kind, name: n.kindName })
    .from(n)
    .where(eq(n.sourceType, 'user'))
    .orderBy(n.kind, n.kindName);
  return {
    apps: candidates.flatMap((app) => {
      const kinds =
        manifests.get(app.currentDeploymentId as string)?.notifications
          ?.kinds ?? [];
      return kinds.length > 0
        ? [{ id: app.id, slug: app.slug, name: app.name, kinds }]
        : [];
    }),
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      kinds: channel.kinds,
    })),
    userKinds,
  };
}

/** ================== destinations ================== */

export async function listDestinations(): Promise<DestinationView[]> {
  const rows = await db.query.notificationDestinations.findMany({
    orderBy: { createdAt: 'asc' },
  });
  const members = await db.query.notificationGroupMembers.findMany({
    columns: { groupId: true, destinationId: true },
  });
  const userIds = [
    ...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : []))),
  ];
  const users =
    userIds.length === 0
      ? []
      : await db.query.user.findMany({
          where: { id: { in: userIds } },
          columns: { id: true, name: true },
        });
  const appIds = [
    ...new Set(rows.flatMap((row) => (row.appId ? [row.appId] : []))),
  ];
  const apps =
    appIds.length === 0
      ? []
      : await db.query.apps.findMany({
          where: { id: { in: appIds } },
          columns: {
            id: true,
            slug: true,
            status: true,
            currentDeploymentId: true,
          },
        });
  const deploymentIds = apps.flatMap((app) =>
    app.currentDeploymentId && app.status !== 'archived'
      ? [app.currentDeploymentId]
      : [],
  );
  const deployments =
    deploymentIds.length === 0
      ? []
      : await db.query.deployments.findMany({
          where: { id: { in: deploymentIds } },
          columns: { id: true, manifestNormalized: true },
        });
  const accepting = new Set(
    deployments.flatMap((deployment) =>
      (deployment.manifestNormalized as NormalizedManifest | null)
        ?.notifications?.destination
        ? [deployment.id]
        : [],
    ),
  );
  const userNames = new Map(users.map((u) => [u.id, u.name]));
  const appById = new Map(apps.map((app) => [app.id, app]));

  return rows.map((row) => {
    const app = row.appId ? appById.get(row.appId) : undefined;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled,
      lastError: row.lastError,
      lifecycleEvents: row.type === 'device' || row.lifecycleEvents,
      acceptsResponses:
        row.type === 'webhook' || (row.type === 'app' && row.acceptsResponses),
      groupIds: members
        .filter((member) => member.destinationId === row.id)
        .map((member) => member.groupId),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
      device:
        row.type === 'device' && row.userId && row.sessionId
          ? {
              platform: row.platform ?? 'ios',
              environment: row.apnsEnvironment ?? 'production',
              userId: row.userId,
              userName: userNames.get(row.userId) ?? null,
              sessionId: row.sessionId,
            }
          : null,
      webhook: row.type === 'webhook' && row.url ? { url: row.url } : null,
      app:
        row.type === 'app' && row.appId
          ? {
              appId: row.appId,
              slug: app?.slug ?? null,
              accepting: Boolean(
                app?.currentDeploymentId &&
                app.status !== 'archived' &&
                accepting.has(app.currentDeploymentId),
              ),
            }
          : null,
    };
  });
}

async function destinationView(id: string): Promise<DestinationView> {
  const view = (await listDestinations()).find((entry) => entry.id === id);
  if (!view) notFound('Destination');
  return view;
}

export async function createWebhook(input: {
  name: string;
  url: string;
  lifecycleEvents?: boolean;
}): Promise<{ destination: DestinationView; secret: string }> {
  const id = newNotificationId();
  const secret = mintWebhookSecret();
  await db.insert(schema.notificationDestinations).values({
    id,
    type: 'webhook',
    name: cleanName(input.name, 'Name'),
    url: cleanWebhookUrl(input.url),
    secretCiphertext: encryptWebhookSecret(id, secret),
    lifecycleEvents: input.lifecycleEvents === true,
  });
  return { destination: await destinationView(id), secret };
}

export async function rotateWebhookSecret(id: string): Promise<string> {
  const row = await db.query.notificationDestinations.findFirst({
    where: { id },
    columns: { type: true },
  });
  if (!row || row.type !== 'webhook') notFound('Webhook');
  const secret = mintWebhookSecret();
  await db
    .update(schema.notificationDestinations)
    .set({ secretCiphertext: encryptWebhookSecret(id, secret) })
    .where(eq(schema.notificationDestinations.id, id));
  return secret;
}

export async function updateDestination(input: {
  id: string;
  name?: string;
  enabled?: boolean;
  url?: string;
  lifecycleEvents?: boolean;
}): Promise<DestinationView> {
  const row = await db.query.notificationDestinations.findFirst({
    where: { id: input.id },
    columns: { type: true, enabled: true, disabledReason: true },
  });
  if (!row) notFound('Destination');
  if (input.enabled && !row.enabled && row.disabledReason === 'device') {
    // The phone dropped its decryption key when push was turned off there;
    // enabling here would only deliver pushes it can no longer read.
    throw new AppError(
      'Push was turned off on this device; turn it back on in the Hatch app.',
      409,
    );
  }
  if (input.url !== undefined && row.type !== 'webhook') {
    throw new AppError('Only webhook destinations have a URL.', 400);
  }
  if (input.lifecycleEvents !== undefined && row.type !== 'webhook') {
    // Devices always take them; an App declares them in its manifest.
    throw new AppError(
      'Only webhook destinations choose whether to receive edits and recalls.',
      400,
    );
  }
  if (input.name !== undefined && row.type === 'app') {
    throw new AppError('App destinations are named after their App.', 400);
  }
  const values = {
    ...(input.name !== undefined
      ? { name: cleanName(input.name, 'Name') }
      : {}),
    ...(input.enabled !== undefined
      ? {
          enabled: input.enabled,
          // Keep the original reason when it is already disabled.
          disabledReason: input.enabled
            ? null
            : row.enabled
              ? ('user' as const)
              : row.disabledReason,
          ...(input.enabled ? { lastError: null } : {}),
        }
      : {}),
    ...(input.url !== undefined ? { url: cleanWebhookUrl(input.url) } : {}),
    ...(input.lifecycleEvents !== undefined
      ? { lifecycleEvents: input.lifecycleEvents }
      : {}),
  };
  if (Object.keys(values).length > 0) {
    await db
      .update(schema.notificationDestinations)
      .set(values)
      .where(eq(schema.notificationDestinations.id, input.id));
  }
  return destinationView(input.id);
}

export async function deleteDestination(id: string): Promise<void> {
  const row = await db.query.notificationDestinations.findFirst({
    where: { id },
    columns: { type: true },
  });
  if (!row) notFound('Destination');
  if (row.type === 'app') {
    throw new AppError(
      'App destinations follow their App; disable it instead.',
      409,
    );
  }
  await db
    .delete(schema.notificationDestinations)
    .where(eq(schema.notificationDestinations.id, id));
}

/** ================== devices ================== */

export type RegisterDeviceInput = {
  sessionId: string;
  userId: string;
  name: string;
  platform: 'ios';
  apnsToken: string;
  apnsEnvironment: 'sandbox' | 'production';
  e2eKeyId: string;
  e2eKey: string;
};

/**
 * Register (or refresh) the push destination for the calling session. One
 * device row per session; an APNs token seen on another session moves here,
 * because the same phone signed in again.
 */
export async function registerDevice(
  input: RegisterDeviceInput,
): Promise<DestinationView> {
  if (!/^[0-9a-f]{16,200}$/i.test(input.apnsToken)) {
    throw new AppError('APNs device token is malformed.', 400);
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.e2eKeyId)) {
    throw new AppError('Device key id is malformed.', 400);
  }
  if (!isValidDeviceKey(input.e2eKey)) {
    throw new AppError('Device key must be 32 bytes of base64url.', 400);
  }
  const name = cleanName(input.name, 'Device name');
  const apnsToken = input.apnsToken.toLowerCase();

  const id = await db.transaction(async (tx) => {
    const existing = await tx.query.notificationDestinations.findFirst({
      where: { sessionId: input.sessionId },
      columns: {
        id: true,
        enabled: true,
        disabledReason: true,
        apnsToken: true,
      },
    });
    // A new device joins auto-add groups. Lock them before the delete below
    // cascades into memberships: group row, then member rows is the order
    // `updateGroup` and `deleteGroup` use, so they cannot deadlock with this.
    const autoAddGroupIds = existing ? [] : await lockAutoAddGroups(tx);
    await tx
      .delete(schema.notificationDestinations)
      .where(
        and(
          eq(schema.notificationDestinations.apnsToken, apnsToken),
          existing
            ? sql`${schema.notificationDestinations.id} <> ${existing.id}`
            : undefined,
        ),
      );
    const destinationId = existing?.id ?? newNotificationId();
    // The app re-registers on every launch and token change, and when push
    // is turned back on there. Registration revives a device the phone itself
    // turned off, or one APNs disabled once it presents a different token; a
    // device disabled in settings stays disabled until settings enable it.
    const revive =
      !existing ||
      existing.enabled ||
      existing.disabledReason === 'device' ||
      (existing.disabledReason === 'unregistered' &&
        existing.apnsToken !== apnsToken);
    // The phone's name only seeds a new device: a name chosen later on the
    // phone or the web must survive the re-registration on every launch.
    const values = {
      type: 'device' as const,
      ...(revive
        ? { enabled: true, disabledReason: null, lastError: null }
        : {}),
      sessionId: input.sessionId,
      userId: input.userId,
      platform: input.platform,
      apnsToken,
      apnsEnvironment: input.apnsEnvironment,
      e2eKeyId: input.e2eKeyId,
      e2eKeyCiphertext: encryptDeviceKey(destinationId, input.e2eKey),
    };
    if (existing) {
      await tx
        .update(schema.notificationDestinations)
        .set(values)
        .where(eq(schema.notificationDestinations.id, destinationId));
    } else {
      await tx
        .insert(schema.notificationDestinations)
        .values({ id: destinationId, name, ...values });
      await joinGroups(tx, autoAddGroupIds, destinationId);
    }
    return destinationId;
  });
  return destinationView(id);
}

/**
 * Push turned off on the phone. The destination keeps its identity, routes and
 * group memberships so turning push back on restores delivery; it is removed
 * only with its sign-in session or from settings.
 */
export async function unregisterDevice(sessionId: string): Promise<void> {
  await db
    .update(schema.notificationDestinations)
    .set({ enabled: false, disabledReason: 'device' })
    .where(eq(schema.notificationDestinations.sessionId, sessionId));
}

/** The calling session's own device destination, if it registered one. */
export async function currentDevice(
  sessionId: string,
): Promise<DestinationView | null> {
  const row = await db.query.notificationDestinations.findFirst({
    where: { sessionId },
    columns: { id: true },
  });
  return row ? destinationView(row.id) : null;
}

/** ================== groups ================== */

/**
 * Lock the groups that auto-add devices, in id order so concurrent
 * registrations cannot deadlock. Concurrent registrations, `updateGroup`
 * (which updates the group row before replacing its members) and
 * `deleteGroup` then serialize per group, so the member count read by
 * `joinGroups` stays valid until commit. Only device creation joins:
 * re-registering an existing device never re-adds it to a group it was
 * removed from.
 */
async function lockAutoAddGroups(tx: TX): Promise<string[]> {
  const groups = await tx
    .select({ id: schema.notificationGroups.id })
    .from(schema.notificationGroups)
    .where(eq(schema.notificationGroups.autoAddDevices, true))
    .orderBy(schema.notificationGroups.id)
    .for('update');
  return groups.map((group) => group.id);
}

/**
 * Add a destination to groups locked by `lockAutoAddGroups`. Full groups are
 * skipped rather than failing the registration.
 */
async function joinGroups(
  tx: TX,
  groupIds: string[],
  destinationId: string,
): Promise<void> {
  if (groupIds.length === 0) return;
  const counts = await tx
    .select({
      groupId: schema.notificationGroupMembers.groupId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.notificationGroupMembers)
    .where(inArray(schema.notificationGroupMembers.groupId, groupIds))
    .groupBy(schema.notificationGroupMembers.groupId);
  const size = new Map(counts.map((row) => [row.groupId, row.count]));
  const open = groupIds.filter(
    (groupId) => (size.get(groupId) ?? 0) < MAX_GROUP_MEMBERS,
  );
  if (open.length === 0) return;
  await tx
    .insert(schema.notificationGroupMembers)
    .values(open.map((groupId) => ({ groupId, destinationId })))
    .onConflictDoNothing();
}

async function assertDestinationsExist(ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_GROUP_MEMBERS) {
    throw new AppError(
      `A group holds at most ${MAX_GROUP_MEMBERS} destinations.`,
      400,
    );
  }
  if (unique.length === 0) return unique;
  const found = await db.query.notificationDestinations.findMany({
    where: { id: { in: unique } },
    columns: { id: true },
  });
  if (found.length !== unique.length) notFound('Destination');
  return unique;
}

export async function listGroups(): Promise<GroupView[]> {
  const groups = await db.query.notificationGroups.findMany({
    orderBy: { name: 'asc' },
  });
  const members = await db.query.notificationGroupMembers.findMany({
    columns: { groupId: true, destinationId: true },
    orderBy: { createdAt: 'asc' },
  });
  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    autoAddDevices: group.autoAddDevices,
    destinationIds: members
      .filter((member) => member.groupId === group.id)
      .map((member) => member.destinationId),
    createdAt: iso(group.createdAt),
    updatedAt: iso(group.updatedAt),
  }));
}

async function groupView(id: string): Promise<GroupView> {
  const view = (await listGroups()).find((group) => group.id === id);
  if (!view) notFound('Group');
  return view;
}

export async function createGroup(input: {
  name: string;
  description?: string | null;
  autoAddDevices?: boolean;
  destinationIds?: string[];
}): Promise<GroupView> {
  const destinationIds = await assertDestinationsExist(
    input.destinationIds ?? [],
  );
  const id = newNotificationId();
  await db.transaction(async (tx) => {
    await tx.insert(schema.notificationGroups).values({
      id,
      name: cleanName(input.name, 'Group name'),
      description: cleanDescription(input.description),
      autoAddDevices: input.autoAddDevices ?? false,
    });
    if (destinationIds.length > 0) {
      await tx.insert(schema.notificationGroupMembers).values(
        destinationIds.map((destinationId) => ({
          groupId: id,
          destinationId,
        })),
      );
    }
  });
  return groupView(id);
}

export async function updateGroup(input: {
  id: string;
  name?: string;
  description?: string | null;
  autoAddDevices?: boolean;
  destinationIds?: string[];
}): Promise<GroupView> {
  const group = await db.query.notificationGroups.findFirst({
    where: { id: input.id },
    columns: { id: true },
  });
  if (!group) notFound('Group');
  const destinationIds =
    input.destinationIds === undefined
      ? undefined
      : await assertDestinationsExist(input.destinationIds);
  await db.transaction(async (tx) => {
    const values = {
      ...(input.name !== undefined
        ? { name: cleanName(input.name, 'Group name') }
        : {}),
      ...(input.description !== undefined
        ? { description: cleanDescription(input.description) }
        : {}),
      ...(input.autoAddDevices !== undefined
        ? { autoAddDevices: input.autoAddDevices }
        : {}),
    };
    await tx
      .update(schema.notificationGroups)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(schema.notificationGroups.id, input.id));
    if (destinationIds !== undefined) {
      await tx
        .delete(schema.notificationGroupMembers)
        .where(eq(schema.notificationGroupMembers.groupId, input.id));
      if (destinationIds.length > 0) {
        await tx.insert(schema.notificationGroupMembers).values(
          destinationIds.map((destinationId) => ({
            groupId: input.id,
            destinationId,
          })),
        );
      }
    }
  });
  return groupView(input.id);
}

export async function deleteGroup(id: string): Promise<void> {
  const deleted = await db
    .delete(schema.notificationGroups)
    .where(eq(schema.notificationGroups.id, id))
    .returning({ id: schema.notificationGroups.id });
  if (deleted.length === 0) notFound('Group');
}

/** ================== routes ================== */

export type RouteInput = {
  name?: string | null;
  sourceType: NotificationRouteSourceType;
  sourceId?: string | null;
  kind?: string | null;
  targetType: 'group' | 'destination';
  targetId: string;
  enabled?: boolean;
};

type RouteRow = typeof schema.notificationRoutes.$inferSelect;

function routeView(row: RouteRow): RouteView {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    sourceId: row.appId ?? row.channelId,
    kind: row.kind,
    targetType: row.targetGroupId ? 'group' : 'destination',
    targetId: (row.targetGroupId ?? row.targetDestinationId) as string,
    enabled: row.enabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * Normalize and check a route's matching criteria. `check: false` skips the
 * declaration lookup for criteria that did not change.
 */
async function routeSource(
  input: Pick<RouteInput, 'sourceType' | 'sourceId' | 'kind'>,
  check: boolean,
) {
  const sourceId = input.sourceId || null;
  const kind = input.kind || null;
  if (kind !== null && !NOTIFICATION_KIND_RE.test(kind)) {
    throw new AppError('Kind is not a valid notification kind.', 400);
  }
  if (input.sourceType === 'any' && sourceId) {
    throw new AppError('A route for any source cannot name a source.', 400);
  }
  if (sourceId && check) {
    const sources = await listNotificationSources();
    const declared =
      input.sourceType === 'app'
        ? sources.apps.find((app) => app.id === sourceId)?.kinds
        : sources.channels.find((channel) => channel.id === sourceId)?.kinds;
    if (!declared)
      notFound(input.sourceType === 'app' ? 'App source' : 'Channel');
    if (kind && !declared.some((entry) => entry.kind === kind)) {
      throw new AppError(`The source does not declare kind "${kind}".`, 400);
    }
  }
  return {
    sourceType: input.sourceType,
    appId: input.sourceType === 'app' ? sourceId : null,
    channelId: input.sourceType === 'channel' ? sourceId : null,
    kind,
  };
}

/**
 * Normalize a route and validate the parts being set. Declarations are only
 * checked for matching criteria or targets that change, so a route whose
 * source later stopped declaring its kind can still be renamed or disabled.
 */
async function routeValues(
  input: RouteInput,
  checks: { source: boolean; target: boolean } = {
    source: true,
    target: true,
  },
) {
  const source = await routeSource(input, checks.source);
  if (!checks.target) {
    // Unchanged target: it still exists, because deleting it cascades.
  } else if (input.targetType === 'group') {
    const group = await db.query.notificationGroups.findFirst({
      where: { id: input.targetId },
      columns: { id: true },
    });
    if (!group) notFound('Group');
  } else {
    const destination = await db.query.notificationDestinations.findFirst({
      where: { id: input.targetId },
      columns: { id: true },
    });
    if (!destination) notFound('Destination');
  }
  const name = input.name?.trim() ? cleanName(input.name, 'Route name') : null;
  return {
    name,
    ...source,
    targetGroupId: input.targetType === 'group' ? input.targetId : null,
    targetDestinationId:
      input.targetType === 'destination' ? input.targetId : null,
    enabled: input.enabled ?? true,
  };
}

export async function listRoutes(): Promise<RouteView[]> {
  const rows = await db.query.notificationRoutes.findMany({
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(routeView);
}

export async function createRoute(input: RouteInput): Promise<RouteView> {
  const [row] = await db
    .insert(schema.notificationRoutes)
    .values({ id: newNotificationId(), ...(await routeValues(input)) })
    .returning();
  return routeView(row);
}

export async function updateRoute(
  input: { id: string } & Partial<RouteInput>,
): Promise<RouteView> {
  const existing = await db.query.notificationRoutes.findFirst({
    where: { id: input.id },
  });
  if (!existing) notFound('Route');
  const current = routeView(existing);
  const merged: RouteInput = {
    name: input.name !== undefined ? input.name : current.name,
    sourceType: input.sourceType ?? current.sourceType,
    sourceId:
      input.sourceId !== undefined
        ? input.sourceId
        : input.sourceType && input.sourceType !== current.sourceType
          ? null
          : current.sourceId,
    kind: input.kind !== undefined ? input.kind : current.kind,
    targetType: input.targetType ?? current.targetType,
    targetId: input.targetId ?? current.targetId,
    enabled: input.enabled ?? current.enabled,
  };
  const checks = {
    source:
      merged.sourceType !== current.sourceType ||
      (merged.sourceId || null) !== current.sourceId ||
      (merged.kind || null) !== current.kind,
    target:
      merged.targetType !== current.targetType ||
      merged.targetId !== current.targetId,
  };
  const [row] = await db
    .update(schema.notificationRoutes)
    .set(await routeValues(merged, checks))
    .where(eq(schema.notificationRoutes.id, input.id))
    .returning();
  return routeView(row);
}

export async function deleteRoute(id: string): Promise<void> {
  const deleted = await db
    .delete(schema.notificationRoutes)
    .where(eq(schema.notificationRoutes.id, id))
    .returning({ id: schema.notificationRoutes.id });
  if (deleted.length === 0) notFound('Route');
}

/** ================== response routes ================== */

/** Longest instructions an Agent response route gives with each answer. */
export const MAX_AGENT_INSTRUCTIONS = 2000;

/**
 * Where a response route sends answers: a webhook or App destination, or the
 * Agent (a fixed chat, or with `sessionId: null` one chat per notification).
 */
export type ResponseRouteTarget =
  | { destinationId: string }
  | { agent: { sessionId: string | null; instructions: string | null } };

export type ResponseRouteInput = {
  name?: string | null;
  sourceType: NotificationRouteSourceType;
  sourceId?: string | null;
  kind?: string | null;
  target: ResponseRouteTarget;
  enabled?: boolean;
};

type ResponseRouteRow = typeof schema.notificationResponseRoutes.$inferSelect;

function responseRouteView(row: ResponseRouteRow): ResponseRouteView {
  return {
    id: row.id,
    name: row.name,
    sourceType: row.sourceType,
    sourceId: row.appId ?? row.channelId,
    kind: row.kind,
    targetType: row.targetType,
    destinationId: row.targetDestinationId,
    agentSessionId: row.agentSessionId,
    agentInstructions: row.agentInstructions,
    enabled: row.enabled,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function responseRouteValues(
  input: ResponseRouteInput,
  checks: { source: boolean; target: boolean } = {
    source: true,
    target: true,
  },
) {
  const source = await routeSource(input, checks.source);
  const name = input.name?.trim() ? cleanName(input.name, 'Route name') : null;
  const enabled = input.enabled ?? true;
  if ('agent' in input.target) {
    const { sessionId } = input.target.agent;
    const instructions = input.target.agent.instructions?.trim() || null;
    if (instructions && instructions.length > MAX_AGENT_INSTRUCTIONS) {
      throw new AppError(
        `Agent instructions must be at most ${MAX_AGENT_INSTRUCTIONS} characters.`,
        400,
      );
    }
    if (checks.target) {
      const session = sessionId
        ? await db.query.agentSessions.findFirst({
            where: { id: sessionId },
            columns: { providerId: true, modelId: true },
          })
        : null;
      if (sessionId && !session) notFound('Agent chat');
      // Answers would only be logged and dropped without a model to run.
      if (
        !(session?.providerId && session.modelId) &&
        !(await getAgentModelCatalog()).defaultModel
      ) {
        throw new AppError(
          'Add an AI provider with a model before sending answers to the Agent.',
          409,
        );
      }
    }
    return {
      name,
      ...source,
      targetType: 'agent' as const,
      targetDestinationId: null,
      agentSessionId: sessionId || null,
      agentInstructions: instructions,
      enabled,
    };
  }
  const { destinationId } = input.target;
  if (checks.target) {
    const destination = await db.query.notificationDestinations.findFirst({
      where: { id: destinationId },
      columns: { id: true, type: true, acceptsResponses: true },
    });
    if (!destination) notFound('Destination');
    if (
      destination.type !== 'webhook' &&
      !(destination.type === 'app' && destination.acceptsResponses)
    ) {
      throw new AppError(
        'Answers can only go to a webhook, or to an App whose manifest sets notifications.destination.responses.',
        400,
      );
    }
  }
  return {
    name,
    ...source,
    targetType: 'destination' as const,
    targetDestinationId: destinationId,
    agentSessionId: null,
    agentInstructions: null,
    enabled,
  };
}

/**
 * Response routes, oldest first. Without a page every route is returned (the
 * settings page shows them all); with one, at most `limit` routes after
 * `cursor` (ids are time-ordered ULIDs) and the cursor for the next page.
 */
export async function listResponseRoutes(page?: {
  cursor?: string;
  limit?: number;
}): Promise<{ routes: ResponseRouteView[]; nextCursor: string | null }> {
  const r = schema.notificationResponseRoutes;
  const limit = page
    ? Math.min(Math.max(page.limit || 50, 1), LIST_LIMIT_MAX)
    : undefined;
  const rows = await db
    .select()
    .from(r)
    .where(page?.cursor ? gt(r.id, page.cursor) : undefined)
    .orderBy(r.id)
    .limit(limit === undefined ? Number.MAX_SAFE_INTEGER : limit + 1);
  const routes = limit === undefined ? rows : rows.slice(0, limit);
  return {
    routes: routes.map(responseRouteView),
    nextCursor:
      limit !== undefined && rows.length > limit ? routes.at(-1)!.id : null,
  };
}

export async function createResponseRoute(
  input: ResponseRouteInput,
): Promise<ResponseRouteView> {
  const [row] = await db
    .insert(schema.notificationResponseRoutes)
    .values({ id: newNotificationId(), ...(await responseRouteValues(input)) })
    .returning();
  return responseRouteView(row!);
}

/**
 * Change a response route. Omitted fields keep their value. A target replaces
 * the current one; for an Agent target, an omitted `sessionId` or
 * `instructions` keeps the current one when the route already goes to the
 * Agent.
 */
export async function updateResponseRoute(
  input: { id: string } & Partial<Omit<ResponseRouteInput, 'target'>> & {
      target?:
        | { destinationId: string }
        | {
            agent: {
              sessionId?: string | null;
              instructions?: string | null;
            };
          };
    },
): Promise<ResponseRouteView> {
  // Lock the row: fields left out keep their current value, never one read
  // before a concurrent change (such as a disable) committed.
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.notificationResponseRoutes)
      .where(eq(schema.notificationResponseRoutes.id, input.id))
      .for('update');
    if (!existing) notFound('Response route');
    return writeResponseRoute(tx, existing, input);
  });
}

async function writeResponseRoute(
  tx: TX,
  existing: ResponseRouteRow,
  input: Parameters<typeof updateResponseRoute>[0],
): Promise<ResponseRouteView> {
  const current = responseRouteView(existing);
  const wasAgent = current.targetType === 'agent';
  const target: ResponseRouteTarget = !input.target
    ? wasAgent
      ? {
          agent: {
            sessionId: current.agentSessionId,
            instructions: current.agentInstructions,
          },
        }
      : { destinationId: current.destinationId! }
    : 'destinationId' in input.target
      ? { destinationId: input.target.destinationId }
      : {
          agent: {
            sessionId:
              input.target.agent.sessionId !== undefined
                ? input.target.agent.sessionId
                : wasAgent
                  ? current.agentSessionId
                  : null,
            instructions:
              input.target.agent.instructions !== undefined
                ? input.target.agent.instructions
                : wasAgent
                  ? current.agentInstructions
                  : null,
          },
        };
  const merged: ResponseRouteInput = {
    name: input.name !== undefined ? input.name : current.name,
    sourceType: input.sourceType ?? current.sourceType,
    sourceId:
      input.sourceId !== undefined
        ? input.sourceId
        : input.sourceType && input.sourceType !== current.sourceType
          ? null
          : current.sourceId,
    kind: input.kind !== undefined ? input.kind : current.kind,
    target,
    enabled: input.enabled ?? current.enabled,
  };
  const checks = {
    source:
      merged.sourceType !== current.sourceType ||
      (merged.sourceId || null) !== current.sourceId ||
      (merged.kind || null) !== current.kind,
    target:
      'agent' in target
        ? !wasAgent ||
          (target.agent.sessionId || null) !== current.agentSessionId
        : target.destinationId !== current.destinationId,
  };
  const [row] = await tx
    .update(schema.notificationResponseRoutes)
    .set(await responseRouteValues(merged, checks))
    .where(eq(schema.notificationResponseRoutes.id, input.id))
    .returning();
  return responseRouteView(row!);
}

export async function deleteResponseRoute(id: string): Promise<void> {
  const deleted = await db
    .delete(schema.notificationResponseRoutes)
    .where(eq(schema.notificationResponseRoutes.id, id))
    .returning({ id: schema.notificationResponseRoutes.id });
  if (deleted.length === 0) notFound('Response route');
}

/** ================== channels ================== */

type ChannelRow = typeof schema.notificationChannels.$inferSelect;

function channelView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kinds: row.kinds,
    enabled: row.enabled,
    pushUrl: `${getPlatformEnv().appUrl}${channelPushPath(row.id)}`,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function cleanKinds(kinds: NotificationKindDeclaration[]) {
  const parsed = channelKindsSchema.safeParse(kinds);
  if (!parsed.success) {
    throw new AppError(
      parsed.error.issues[0]?.message ?? 'Channel kinds are invalid.',
      400,
    );
  }
  return parsed.data.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

export async function listChannels(): Promise<ChannelView[]> {
  const rows = await db.query.notificationChannels.findMany({
    orderBy: { name: 'asc' },
  });
  return rows.map(channelView);
}

export async function createChannel(input: {
  name: string;
  description?: string | null;
  kinds: NotificationKindDeclaration[];
}): Promise<{ channel: ChannelView; token: string }> {
  const token = mintChannelToken();
  const [row] = await db
    .insert(schema.notificationChannels)
    .values({
      id: newNotificationId(),
      name: cleanName(input.name, 'Channel name'),
      description: cleanDescription(input.description),
      kinds: cleanKinds(input.kinds),
      tokenHash: hashChannelToken(token),
    })
    .returning();
  return { channel: channelView(row), token };
}

export async function updateChannel(input: {
  id: string;
  name?: string;
  description?: string | null;
  kinds?: NotificationKindDeclaration[];
  enabled?: boolean;
}): Promise<ChannelView> {
  const values = {
    ...(input.name !== undefined
      ? { name: cleanName(input.name, 'Channel name') }
      : {}),
    ...(input.description !== undefined
      ? { description: cleanDescription(input.description) }
      : {}),
    ...(input.kinds !== undefined ? { kinds: cleanKinds(input.kinds) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
  const [row] = await db
    .update(schema.notificationChannels)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.notificationChannels.id, input.id))
    .returning();
  if (!row) notFound('Channel');
  return channelView(row);
}

export async function rotateChannelToken(id: string): Promise<string> {
  const token = mintChannelToken();
  const updated = await db
    .update(schema.notificationChannels)
    .set({ tokenHash: hashChannelToken(token) })
    .where(eq(schema.notificationChannels.id, id))
    .returning({ id: schema.notificationChannels.id });
  if (updated.length === 0) notFound('Channel');
  return token;
}

export async function deleteChannel(id: string): Promise<void> {
  const deleted = await db
    .delete(schema.notificationChannels)
    .where(eq(schema.notificationChannels.id, id))
    .returning({ id: schema.notificationChannels.id });
  if (deleted.length === 0) notFound('Channel');
}

/** ================== operations ================== */

const TEST_KIND = { kind: 'test', name: 'Test notification' };

/** Send a test notification straight to one destination, bypassing routes. */
export async function sendTestNotification(
  destinationId: string,
): Promise<{ id: string }> {
  const destination = await db.query.notificationDestinations.findFirst({
    where: { id: destinationId },
    columns: { id: true, name: true, enabled: true },
  });
  if (!destination) notFound('Destination');
  if (!destination.enabled) {
    throw new AppError('Enable the destination before testing it.', 409);
  }
  const push: NotificationPush = {
    kind: TEST_KIND.kind,
    title: 'Test notification',
    body: `This is a test sent to "${destination.name}" from Hatch.`,
    url: null,
    autoOpenUrl: false,
    priority: DEFAULT_NOTIFICATION_PRIORITY,
    data: null,
    reply: null,
    card: null,
    dedupeKey: null,
    occurredAt: null,
  };
  const result = await ingestNotification({
    source: { type: 'platform', name: 'Hatch' },
    kind: TEST_KIND,
    push,
    target: { type: 'destination', id: destination.id },
  });
  return { id: result.id };
}

/** Kind of a user-addressed send that names none. */
export const USER_MESSAGE_KIND = { kind: 'message', name: 'Message' };

export type SendNotificationTarget =
  | { type: 'channel'; id: string }
  | NotificationTarget;

/** Who a direct (group or destination) send comes from. */
export type DirectSender = Extract<
  NotificationSource,
  { type: 'user' } | { type: 'platform' }
>;

/** Sender of direct sends made with an Agent Run credential. */
export const AGENT_SENDER: DirectSender = {
  type: 'platform',
  name: 'Hatch Agent',
};

/**
 * Send a notification on behalf of a user (session or API key) or the
 * platform Agent (Run credential).
 *
 * - `channel`: as that Channel, without its token: the same body rules,
 *   declared kinds, dedupe scope and routing as a token push.
 * - `group` / `destination`: from the sender, never routed. It reaches the
 *   destination, or the group's enabled members. `kind` is a free label
 *   (default `message`), and dedupe keys are scoped to the sending user, or
 *   shared by all platform sends.
 */
export async function sendNotification(input: {
  to: SendNotificationTarget;
  sender: DirectSender;
  body: Record<string, unknown>;
}): Promise<{ id: string; deduplicated: boolean; deliveries: number }> {
  const { to, sender, body } = input;
  if (to.type === 'channel') {
    const channel = await db.query.notificationChannels.findFirst({
      where: { id: to.id },
      columns: { id: true, name: true, kinds: true, enabled: true },
    });
    if (!channel) notFound('Channel');
    if (!channel.enabled) {
      throw new AppError('Enable the channel before sending to it.', 409);
    }
    const result = await ingestChannelPush(channel, body);
    if (!result.ok) throw new AppError(`${result.message}.`, 400);
    return {
      id: result.id,
      deduplicated: result.deduplicated,
      deliveries: result.deliveries,
    };
  }

  if (to.type === 'group') {
    const group = await db.query.notificationGroups.findFirst({
      where: { id: to.id },
      columns: { id: true },
    });
    if (!group) notFound('Group');
  } else {
    const destination = await db.query.notificationDestinations.findFirst({
      where: { id: to.id },
      columns: { id: true, enabled: true },
    });
    if (!destination) notFound('Destination');
    if (!destination.enabled) {
      throw new AppError('Enable the destination before sending to it.', 409);
    }
  }
  const push = notificationPushSchema.safeParse({
    ...body,
    kind: body.kind ?? USER_MESSAGE_KIND.kind,
  });
  if (!push.success) {
    throw new AppError(`${pushIssueMessage(push.error)}.`, 400);
  }
  const kind =
    push.data.kind === USER_MESSAGE_KIND.kind
      ? USER_MESSAGE_KIND
      : { kind: push.data.kind, name: push.data.kind };
  return ingestNotification({
    source: sender,
    kind,
    push: push.data,
    target: to,
  });
}

async function asAppError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotificationLifecycleError) {
      throw new AppError(`${error.message}.`, error.status);
    }
    throw error;
  }
}

/**
 * Edit any notification by id on behalf of a workspace member (session, API
 * key or Agent Run), whatever sent it: members are all equal
 * (SendNotification's peer).
 */
export async function updateNotificationAsMember(
  body: unknown,
): Promise<LifecycleResult> {
  const update = notificationUpdateSchema.safeParse(body);
  if (!update.success) {
    // Reply form issues name the field to fix (`reply.fields.0: …`).
    throw new AppError(`${pushIssueMessage(update.error)}.`, 400);
  }
  return asAppError(() => updateNotification({ type: 'member' }, update.data));
}

/** Recall any notification by id on behalf of a workspace member. */
export async function recallNotificationAsMember(
  id: string,
): Promise<LifecycleResult> {
  return asAppError(() => recallNotification({ type: 'member' }, id));
}

/**
 * Delete a notification and its delivery records from history on behalf of a
 * workspace member, whatever sent it. Destinations are not told: copies that
 * already arrived stay where they are (recall first to remove them from
 * phones), deliveries that were still due are dropped, and an attempt already
 * in flight finishes without being recorded. The dedupe key is released, so a
 * repeated push with it becomes a new notification.
 */
export async function deleteNotification(id: string): Promise<void> {
  const [row] = await db
    .delete(schema.notifications)
    .where(eq(schema.notifications.id, id))
    .returning({ id: schema.notifications.id });
  if (!row) notFound('Notification');
  publishPlatformEvent({ type: 'notification.deleted', notificationId: id });
}

export function apnsStatus(): ApnsStatusView {
  return describeApnsCredentials();
}
