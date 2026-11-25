/**
 * Server functions for the notification center Web UI.
 *
 * NOTE: this module is import-reachable from client code (`~queries/...`), so
 * it exports only server functions and types; every domain call lives inside
 * a handler and is delegated to `./notifications/service`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
import {
  apnsStatus,
  createChannel,
  createGroup,
  createResponseRoute,
  createRoute,
  createWebhook,
  deleteChannel,
  deleteDestination,
  deleteGroup,
  deleteResponseRoute,
  deleteNotification,
  deleteRoute,
  getNotification,
  listChannels,
  listDestinations,
  listGroups,
  listNotificationRevisions,
  listNotificationSources,
  listNotifications,
  listResponseRoutes,
  listRoutes,
  retryDelivery,
  rotateChannelToken,
  rotateWebhookSecret,
  sendTestNotification,
  updateChannel,
  updateDestination,
  updateGroup,
  updateResponseRoute,
  updateRoute,
} from './notifications/service';
import {
  getReadState,
  markNotificationsRead,
} from './notifications/read-state';
import { respondToNotification } from './notifications/responses';
import { idSchema } from './validation';
import type { JsonObject } from '~/db/schema';
import type { NotificationDetailView } from './notifications/service';

/** Notification detail with its JSON data typed for serialization. */
export type NotificationDetail = Omit<NotificationDetailView, 'data'> & {
  data: JsonObject | null;
};

export type {
  ApnsStatusView,
  ChannelView,
  DeliveryView,
  DestinationView,
  GroupView,
  NotificationDetailView,
  NotificationSourcesView,
  NotificationStatus,
  NotificationReplyState,
  NotificationSummaryView,
  ResponseRouteView,
  RouteView,
} from './notifications/service';
export type { NotificationResponseView } from './notifications/responses';
export type { NotificationReadState } from './notifications/read-state';

const shortText = z.string().max(200);
const kindsSchema = z
  .array(
    z.object({
      kind: z.string().max(64),
      name: z.string().max(80),
      description: z.string().max(500).optional(),
    }),
  )
  .max(100);

const listInputSchema = z.object({
  sourceType: z.enum(['app', 'channel', 'platform', 'user']).optional(),
  sourceId: idSchema.optional(),
  kind: z.string().max(64).optional(),
  status: z
    .enum(['unrouted', 'pending', 'delivered', 'partial', 'failed'])
    .optional(),
  replyState: z.enum(['awaiting', 'answered']).optional(),
  order: z.enum(['created', 'activity']).optional(),
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listNotificationsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof listInputSchema>) =>
    listInputSchema.parse(input),
  )
  .handler(({ data }) => listNotifications(data));

export const getNotificationFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }): Promise<NotificationDetail> => {
    const detail = await getNotification(data);
    // Stored notification data is always a JSON object (validated on ingest).
    return { ...detail, data: detail.data as JsonObject | null };
  });

export const retryDeliveryFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((deliveryId: string) => idSchema.parse(deliveryId))
  .handler(async ({ data }) => {
    await retryDelivery(data);
    return { ok: true as const };
  });

const answerSchema = z.object({
  id: idSchema,
  // The round of the form on screen; a new question since then refuses it.
  round: z.number().int().min(1),
  // Checked against the notification's form by the domain service.
  answers: z.record(
    z.string().max(64),
    z.union([z.string().max(8000), z.array(z.string().max(64)).max(100)]),
  ),
});

/** Answer a notification's reply form as the signed-in user. */
export const respondToNotificationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof answerSchema>) => answerSchema.parse(input))
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    return respondToNotification(
      data.id,
      data.answers,
      { userId: user.id, via: 'web' },
      { round: data.round },
    );
  });

/** What a notification said before each edit, and every answer it took. */
const revisionsPageSchema = z.object({
  id: idSchema,
  cursor: z.string().max(64).optional(),
});

export const listNotificationRevisionsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof revisionsPageSchema>) =>
    revisionsPageSchema.parse(input),
  )
  .handler(async ({ data }) => {
    const history = await listNotificationRevisions(data.id, {
      cursor: data.cursor,
    });
    return {
      ...history,
      // Stored notification data is always a JSON object.
      revisions: history.revisions.map((revision) => ({
        ...revision,
        data: revision.data as JsonObject | null,
      })),
    };
  });

/** How far the signed-in user has read the timeline. */
export const getNotificationReadStateFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    const { user } = await requireSession();
    return getReadState({ type: 'user', userId: user.id });
  });

const markReadSchema = z.union([
  // The activity time of the version on screen, so an edit that arrived
  // since stays unread.
  z.object({ notificationId: idSchema, activityAt: z.coerce.date() }),
  z.object({ latest: z.literal(true) }),
]);

/** Move the signed-in user's read position forward. */
export const markNotificationsReadFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof markReadSchema>) =>
    markReadSchema.parse(input),
  )
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    return markNotificationsRead({ type: 'user', userId: user.id }, data);
  });

export const deleteNotificationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteNotification(data);
    return { ok: true as const };
  });

export const sendTestNotificationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((destinationId: string) => idSchema.parse(destinationId))
  .handler(({ data }) => sendTestNotification(data));

export const listNotificationSourcesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listNotificationSources());

export const getApnsStatusFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => apnsStatus());

/** ================== destinations ================== */

export const listDestinationsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listDestinations());

const createWebhookSchema = z.object({
  name: shortText,
  url: z.string().max(2048),
  lifecycleEvents: z.boolean().optional(),
});

export const createWebhookFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof createWebhookSchema>) =>
    createWebhookSchema.parse(input),
  )
  .handler(({ data }) => createWebhook(data));

const updateDestinationSchema = z.object({
  id: idSchema,
  name: shortText.optional(),
  enabled: z.boolean().optional(),
  url: z.string().max(2048).optional(),
  lifecycleEvents: z.boolean().optional(),
});

export const updateDestinationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateDestinationSchema>) =>
    updateDestinationSchema.parse(input),
  )
  .handler(({ data }) => updateDestination(data));

export const rotateWebhookSecretFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => ({ secret: await rotateWebhookSecret(data) }));

export const deleteDestinationFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteDestination(data);
    return { ok: true as const };
  });

/** ================== groups ================== */

export const listGroupsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listGroups());

const groupSchema = z.object({
  name: shortText,
  description: z.string().max(500).nullable().optional(),
  autoAddDevices: z.boolean().optional(),
  destinationIds: z.array(idSchema).max(200).optional(),
});

export const createGroupFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof groupSchema>) => groupSchema.parse(input))
  .handler(({ data }) => createGroup(data));

const updateGroupSchema = groupSchema.partial().extend({ id: idSchema });

export const updateGroupFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateGroupSchema>) =>
    updateGroupSchema.parse(input),
  )
  .handler(({ data }) => updateGroup(data));

export const deleteGroupFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteGroup(data);
    return { ok: true as const };
  });

/** ================== routes ================== */

export const listRoutesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listRoutes());

const routeSchema = z.object({
  name: shortText.nullable().optional(),
  sourceType: z.enum(['app', 'channel', 'any']),
  sourceId: idSchema.nullable().optional(),
  kind: z.string().max(64).nullable().optional(),
  targetType: z.enum(['group', 'destination']),
  targetId: idSchema,
  enabled: z.boolean().optional(),
});

export const createRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof routeSchema>) => routeSchema.parse(input))
  .handler(({ data }) => createRoute(data));

const updateRouteSchema = routeSchema.partial().extend({ id: idSchema });

export const updateRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateRouteSchema>) =>
    updateRouteSchema.parse(input),
  )
  .handler(({ data }) => updateRoute(data));

export const deleteRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteRoute(data);
    return { ok: true as const };
  });

/** ================== response routes ================== */

export const listResponseRoutesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => (await listResponseRoutes()).routes);

const agentTargetSchema = z.object({
  sessionId: idSchema.nullable().optional(),
  instructions: z.string().max(2000).nullable().optional(),
});

const responseRouteTargetSchema = z.union([
  z.object({ destinationId: idSchema }),
  z.object({ agent: agentTargetSchema }),
]);

const responseRouteSchema = z.object({
  name: shortText.nullable().optional(),
  sourceType: z.enum(['app', 'channel', 'any']),
  sourceId: idSchema.nullable().optional(),
  kind: z.string().max(64).nullable().optional(),
  target: responseRouteTargetSchema,
  enabled: z.boolean().optional(),
});

export const createResponseRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof responseRouteSchema>) =>
    responseRouteSchema.parse(input),
  )
  .handler(({ data }) =>
    createResponseRoute({
      ...data,
      target:
        'agent' in data.target
          ? {
              agent: {
                sessionId: data.target.agent.sessionId ?? null,
                instructions: data.target.agent.instructions ?? null,
              },
            }
          : data.target,
    }),
  );

const updateResponseRouteSchema = responseRouteSchema
  .partial()
  .extend({ id: idSchema });

export const updateResponseRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateResponseRouteSchema>) =>
    updateResponseRouteSchema.parse(input),
  )
  .handler(({ data }) => updateResponseRoute(data));

export const deleteResponseRouteFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteResponseRoute(data);
    return { ok: true as const };
  });

/** ================== channels ================== */

export const listChannelsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listChannels());

const channelSchema = z.object({
  name: shortText,
  description: z.string().max(500).nullable().optional(),
  kinds: kindsSchema,
});

export const createChannelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof channelSchema>) =>
    channelSchema.parse(input),
  )
  .handler(({ data }) => createChannel(data));

const updateChannelSchema = channelSchema
  .partial()
  .extend({ id: idSchema, enabled: z.boolean().optional() });

export const updateChannelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateChannelSchema>) =>
    updateChannelSchema.parse(input),
  )
  .handler(({ data }) => updateChannel(data));

export const rotateChannelTokenFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => ({ token: await rotateChannelToken(data) }));

export const deleteChannelFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data }) => {
    await deleteChannel(data);
    return { ok: true as const };
  });
