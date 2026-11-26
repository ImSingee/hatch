/** Connect adapter for the notification center management API. */
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect';
import { AppError } from '~server/errors';
import { NotificationService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/notification_pb';
import {
  cardHead,
  type ContentNode,
  type NotificationFormat,
} from '../../../packages/hatch-platform-api/notification-content';
import { contentToPlainText } from '../../../packages/hatch-platform-api/notification-content-text';
import {
  answersFromMessages,
  answersToMessages,
  replyInputFromMessage,
  replyToMessage,
} from '../../../packages/hatch-platform-api/notification-reply-proto';
import type {
  NotificationKindDeclaration,
  NotificationRouteSourceType,
  NotificationSourceType,
} from '~/db/schema';
import {
  AGENT_SENDER,
  apnsStatus,
  createChannel,
  createGroup,
  createResponseRoute,
  createRoute,
  createWebhook,
  currentDevice,
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
  listNotificationSources,
  listNotifications,
  listResponseRoutes,
  listRoutes,
  registerDevice,
  retryDelivery,
  rotateChannelToken,
  rotateWebhookSecret,
  recallNotificationAsMember,
  sendNotification,
  updateNotificationAsMember,
  sendTestNotification,
  unregisterDevice,
  updateChannel,
  updateDestination,
  updateGroup,
  listNotificationRevisions,
  updateResponseRoute,
  updateRoute,
  type ChannelView,
  type DeliveryView,
  type DestinationView,
  type DirectSender,
  type NotificationListOrder,
  type NotificationReplyState,
  type NotificationStatus,
  type NotificationSummaryView,
  type ResponseRouteView,
} from '~server/notifications/service';
import {
  respondToNotification,
  type NotificationResponseView,
} from '~server/notifications/responses';
import { MAX_NOTIFICATION_BODY_BYTES } from '~server/notifications/contract';
import {
  getReadState,
  markNotificationsRead,
  type NotificationReadState,
  type NotificationReader,
} from '~server/notifications/read-state';
import { publicApiError } from './errors';
import { publicApiContext } from './context';

const none = <T>(value: T | null | undefined) => value ?? undefined;

function destination(view: DestinationView) {
  return {
    ...view,
    lastError: none(view.lastError),
    device: view.device
      ? { ...view.device, userName: none(view.device.userName) }
      : undefined,
    webhook: none(view.webhook),
    app: view.app ? { ...view.app, slug: none(view.app.slug) } : undefined,
  };
}

function kinds(list: NotificationKindDeclaration[]) {
  return list.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    description: entry.description,
  }));
}

function channel(view: ChannelView) {
  return {
    ...view,
    description: none(view.description),
    kinds: kinds(view.kinds),
  };
}

/**
 * A notification's content as NotificationSummary and NotificationRevision
 * carry it: `title` and `body` for text, the tree and its plain text for
 * markdown and card.
 */
function contentFields(view: {
  format: NotificationFormat;
  title: string | null;
  body: string | null;
  summary: string | null;
  markdown: string | null;
  content: ContentNode | null;
}) {
  const text =
    view.format !== 'text' && view.content
      ? contentToPlainText(view.content)
      : undefined;
  const head = cardHead(view.content);
  return {
    format: view.format,
    title: none(view.title),
    body: none(view.body),
    summary: none(view.summary),
    markdown: none(view.markdown),
    contentJson: view.content ? JSON.stringify(view.content) : undefined,
    text,
    flag: none(head.flag),
    icon: none(head.icon),
    cardStatus: head.status ?? undefined,
  };
}

function summary(view: NotificationSummaryView) {
  const { content: _content, ...rest } = view;
  return {
    ...rest,
    ...contentFields(view),
    sourceId: none(view.sourceId),
    url: none(view.url),
    editedAt: none(view.editedAt),
    recalledAt: none(view.recalledAt),
    reply: view.reply ? replyToMessage(view.reply) : undefined,
    respondedAt: none(view.respondedAt),
    response: view.response ? response(view.response) : undefined,
  };
}

/**
 * The card a request gives: markup or a JSON tree (`card_json`, parsed here
 * so a JSON error names it); at most one of them.
 */
function cardFromRequest(input: {
  cardMarkup?: string;
  cardJson?: string;
}): unknown {
  if (input.cardMarkup !== undefined && input.cardJson !== undefined) {
    throw publicApiError(
      'BAD_REQUEST',
      'Set only one of card_markup or card_json.',
    );
  }
  if (input.cardMarkup !== undefined) return input.cardMarkup;
  if (input.cardJson === undefined) return undefined;
  try {
    return JSON.parse(input.cardJson) as unknown;
  } catch {
    throw publicApiError('BAD_REQUEST', 'card_json must be valid JSON.');
  }
}

function delivery(view: DeliveryView) {
  return {
    ...view,
    destinationId: none(view.destinationId),
    nextAttemptAt: none(view.nextAttemptAt),
    lastError: none(view.lastError),
    httpStatus: none(view.httpStatus),
    result: none(view.result),
    deliveredRevision: none(view.deliveredRevision),
    completedAt: none(view.completedAt),
  };
}

function response(view: NotificationResponseView) {
  return {
    answers: answersToMessages(view.answers),
    respondedByUserId: none(view.respondedBy.userId),
    respondedByName: view.respondedBy.name,
    via: view.via,
    destinationId: none(view.destinationId),
    respondedAt: view.respondedAt,
    round: view.round,
  };
}

function responseRoute(view: ResponseRouteView) {
  return {
    ...view,
    name: none(view.name),
    sourceId: none(view.sourceId),
    kind: none(view.kind),
    destinationId: none(view.destinationId),
    agentSessionId: none(view.agentSessionId),
    agentInstructions: none(view.agentInstructions),
  };
}

/**
 * The target an UpdateResponseRoute names: a destination, the Agent (unset
 * chat or instructions keep theirs; an empty string clears them), or none.
 */
function agentOrDestination(input: {
  destinationId?: string;
  agent: boolean;
  agentSessionId?: string;
  agentInstructions?: string;
}) {
  if (input.destinationId && input.agent) {
    throw publicApiError(
      'BAD_REQUEST',
      'Set either destination_id or agent, not both.',
    );
  }
  if (input.destinationId) return { destinationId: input.destinationId };
  const agentChange =
    input.agentSessionId !== undefined || input.agentInstructions !== undefined;
  if (!input.agent && !agentChange) return undefined;
  return {
    agent: {
      ...(input.agentSessionId !== undefined
        ? { sessionId: input.agentSessionId || null }
        : {}),
      ...(input.agentInstructions !== undefined
        ? { instructions: input.agentInstructions || null }
        : {}),
    },
  };
}

function kindInput(
  list: { kind: string; name: string; description?: string }[],
): NotificationKindDeclaration[] {
  return list.map((entry) => ({
    kind: entry.kind,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
  }));
}

/** `data_json` must be a JSON object; empty or absent means no data. */
function dataObject(json: string | undefined): unknown {
  if (!json) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw publicApiError('BAD_REQUEST', 'data_json must be valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw publicApiError('BAD_REQUEST', 'data_json must be a JSON object.');
  }
  return value;
}

/**
 * Who a direct send comes from: the user behind a session or API key, or the
 * platform Agent for a Run credential (Runs have no user of their own).
 */
function senderOf(context: HandlerContext): DirectSender {
  const status = context.values.get(publicApiContext).status;
  if (
    status?.credentialType === 'session' ||
    status?.credentialType === 'api-key'
  ) {
    const { user } = status;
    return { type: 'user', userId: user.id, name: user.name || user.email };
  }
  return AGENT_SENDER;
}

/** Whose read position a call uses: the caller, or the platform Agent for a Run. */
function readerOf(context: HandlerContext): NotificationReader {
  const sender = senderOf(context);
  return sender.type === 'user'
    ? { type: 'user', userId: sender.userId }
    : { type: 'agent' };
}

function readState(state: NotificationReadState) {
  return {
    ...state,
    readThroughId: none(state.readThroughId),
    firstUnreadId: none(state.firstUnreadId),
  };
}

/** A device destination belongs to the native login session that registered it. */
function sessionOf(context: HandlerContext) {
  const auth = context.values.get(publicApiContext);
  if (auth.status?.credentialType !== 'session' || !auth.session) {
    throw publicApiError('SESSION_REQUIRED');
  }
  return { sessionId: auth.session.id, userId: auth.status.user.id };
}

/**
 * SendNotification carries `data_json` as a string inside the request, so
 * escaping can double the 32 KiB data and text fields of a Channel push. The
 * request gate authenticates before the body is read, so only authenticated
 * callers can send bodies this large.
 */
export const NOTIFICATION_RPC_BODY_LIMIT = 2 * MAX_NOTIFICATION_BODY_BYTES;

export function registerNotificationApi(router: ConnectRouter) {
  router.service(
    NotificationService,
    {
      listNotifications: async (input) => {
        const page = await listNotifications({
          sourceType: input.sourceType as NotificationSourceType | undefined,
          sourceId: input.sourceId,
          kind: input.kind || undefined,
          status: input.status as NotificationStatus | undefined,
          replyState: input.replyState as NotificationReplyState | undefined,
          order: input.order as NotificationListOrder | undefined,
          cursor: input.cursor || undefined,
          limit: input.limit || undefined,
        });
        return {
          notifications: page.items.map(summary),
          nextCursor: none(page.nextCursor),
        };
      },
      getNotification: async (input) => {
        const detail = await getNotification(input.id);
        return {
          notification: {
            summary: summary(detail),
            dataJson: detail.data ? JSON.stringify(detail.data) : undefined,
            dedupeKey: none(detail.dedupeKey),
            deliveries: detail.deliveryList.map(delivery),
            response: detail.response ? response(detail.response) : undefined,
            responseDeliveries: detail.responseDeliveryList.map(delivery),
          },
        };
      },
      retryDelivery: async (input) => {
        await retryDelivery(input.deliveryId);
        return {};
      },
      sendTestNotification: async (input) => ({
        notificationId: (await sendTestNotification(input.destinationId)).id,
      }),
      sendNotification: async (input, context) => {
        // Protovalidate requires exactly one recipient.
        const to = input.channelId
          ? { type: 'channel' as const, id: input.channelId }
          : input.groupId
            ? { type: 'group' as const, id: input.groupId }
            : { type: 'destination' as const, id: input.destinationId };
        const sender = senderOf(context);
        const run = context.values.get(publicApiContext).run;
        const result = await sendNotification({
          to,
          // A Run's send remembers its chat, so answers come back to it.
          sender:
            sender.type === 'platform' && run
              ? { ...sender, agentSessionId: run.sessionId }
              : sender,
          body: {
            kind: input.kind || undefined,
            title: input.title || undefined,
            body: input.body,
            summary: input.summary,
            markdown: input.markdown,
            card: cardFromRequest(input),
            url: input.url,
            autoOpenUrl: input.autoOpenUrl,
            priority: input.priority,
            data: dataObject(input.dataJson),
            dedupeKey: input.dedupeKey,
            occurredAt: input.occurredAt,
            reply: input.reply ? replyInputFromMessage(input.reply) : undefined,
          },
        });
        return {
          notificationId: result.id,
          deduplicated: result.deduplicated,
          deliveryCount: result.deliveries,
        };
      },
      updateNotification: async (input) => {
        if (input.reply && input.clearReply) {
          throw publicApiError(
            'BAD_REQUEST',
            'Set either reply or clear_reply, not both.',
          );
        }
        if (input.summary !== undefined && input.clearSummary) {
          throw publicApiError(
            'BAD_REQUEST',
            'Set either summary or clear_summary, not both.',
          );
        }
        const result = await updateNotificationAsMember({
          id: input.id,
          title: input.title,
          body: input.body,
          url: input.url,
          autoOpenUrl: input.autoOpenUrl,
          silent: input.silent,
          // An empty string clears the data; unset keeps it.
          data:
            input.dataJson === undefined
              ? undefined
              : input.dataJson === ''
                ? null
                : dataObject(input.dataJson),
          reply: input.clearReply
            ? null
            : input.reply
              ? replyInputFromMessage(input.reply)
              : undefined,
          summary: input.clearSummary ? null : input.summary,
          markdown: input.markdown,
          card: cardFromRequest(input),
        });
        return { revision: result.revision, changed: result.changed };
      },
      recallNotification: async (input) => {
        const result = await recallNotificationAsMember(input.id);
        return { revision: result.revision, changed: result.changed };
      },
      respondToNotification: async (input, context) => {
        // A Run has no user: it answers as the platform Agent.
        const sender = senderOf(context);
        const answered = await respondToNotification(
          input.id,
          answersFromMessages(input.answers),
          {
            userId: sender.type === 'user' ? sender.userId : null,
            name: sender.name,
            via: input.via === 'mobile' ? 'mobile' : 'cli',
          },
          input.round > 0 ? { round: input.round } : undefined,
        );
        return { response: response(answered) };
      },
      deleteNotification: async (input) => {
        await deleteNotification(input.id);
        return {};
      },
      listNotificationRevisions: async (input) => {
        const history = await listNotificationRevisions(input.id, {
          cursor: input.cursor || undefined,
          limit: input.limit || undefined,
        });
        return {
          nextCursor: history.nextCursor ?? undefined,
          revisions: history.revisions.map(
            ({ content: _content, data, ...revision }) => ({
              ...revision,
              ...contentFields({ ...revision, content: _content }),
              url: none(revision.url),
              dataJson: data ? JSON.stringify(data) : undefined,
              reply: revision.reply
                ? replyToMessage(revision.reply)
                : undefined,
            }),
          ),
          responses: history.responses.map(response),
        };
      },
      getNotificationReadState: async (_input, context) => ({
        state: readState(await getReadState(readerOf(context))),
      }),
      markNotificationsRead: async (input, context) => {
        const activityAt = input.activityAt
          ? new Date(input.activityAt)
          : undefined;
        if (activityAt && Number.isNaN(activityAt.getTime())) {
          throw new AppError('activity_at must be an RFC 3339 time.', 400);
        }
        if (activityAt && input.through.case !== 'notificationId') {
          throw new AppError('activity_at needs notification_id.', 400);
        }
        const through =
          input.through.case === 'notificationId'
            ? { notificationId: input.through.value, activityAt }
            : { latest: true as const };
        return {
          state: readState(
            await markNotificationsRead(readerOf(context), through),
          ),
        };
      },
      listNotificationSources: async () => {
        const sources = await listNotificationSources();
        return {
          apps: sources.apps.map((app) => ({
            ...app,
            kinds: kinds(app.kinds),
          })),
          channels: sources.channels.map((entry) => ({
            ...entry,
            kinds: kinds(entry.kinds),
          })),
          userKinds: kinds(sources.userKinds),
        };
      },
      getApnsStatus: () => {
        const status = apnsStatus();
        return {
          ...status,
          topic: none(status.topic),
          error: none(status.error),
        };
      },

      listDestinations: async () => ({
        destinations: (await listDestinations()).map(destination),
      }),
      createWebhook: async (input) => {
        const created = await createWebhook(input);
        return {
          destination: destination(created.destination),
          secret: created.secret,
        };
      },
      updateDestination: async (input) => ({
        destination: destination(
          await updateDestination({
            id: input.id,
            name: input.name,
            enabled: input.enabled,
            url: input.url,
            lifecycleEvents: input.lifecycleEvents,
          }),
        ),
      }),
      rotateWebhookSecret: async (input) => ({
        secret: await rotateWebhookSecret(input.id),
      }),
      deleteDestination: async (input) => {
        await deleteDestination(input.id);
        return {};
      },

      registerDevice: async (input, context) => {
        const { sessionId, userId } = sessionOf(context);
        return {
          destination: destination(
            await registerDevice({
              sessionId,
              userId,
              name: input.name,
              platform: 'ios',
              apnsToken: input.apnsToken,
              apnsEnvironment: input.apnsEnvironment as
                | 'sandbox'
                | 'production',
              e2eKeyId: input.e2eKeyId,
              e2eKey: input.e2eKey,
            }),
          ),
        };
      },
      unregisterDevice: async (_input, context) => {
        await unregisterDevice(sessionOf(context).sessionId);
        return {};
      },
      getCurrentDevice: async (_input, context) => {
        const view = await currentDevice(sessionOf(context).sessionId);
        return { destination: view ? destination(view) : undefined };
      },

      listGroups: async () => ({
        groups: (await listGroups()).map((group) => ({
          ...group,
          description: none(group.description),
        })),
      }),
      createGroup: async (input) => {
        const group = await createGroup({
          name: input.name,
          description: input.description,
          autoAddDevices: input.autoAddDevices,
          destinationIds: input.destinationIds?.ids ?? [],
        });
        return { group: { ...group, description: none(group.description) } };
      },
      updateGroup: async (input) => {
        const group = await updateGroup({
          id: input.id,
          name: input.name,
          description: input.description,
          autoAddDevices: input.autoAddDevices,
          destinationIds: input.destinationIds?.ids,
        });
        return { group: { ...group, description: none(group.description) } };
      },
      deleteGroup: async (input) => {
        await deleteGroup(input.id);
        return {};
      },

      listRoutes: async () => ({
        routes: (await listRoutes()).map((route) => ({
          ...route,
          name: none(route.name),
          sourceId: none(route.sourceId),
          kind: none(route.kind),
        })),
      }),
      createRoute: async (input) => {
        const route = await createRoute({
          name: input.name,
          sourceType: input.sourceType as NotificationRouteSourceType,
          sourceId: input.sourceId,
          kind: input.kind,
          targetType: input.targetType as 'group' | 'destination',
          targetId: input.targetId,
          enabled: input.enabled,
        });
        return {
          route: {
            ...route,
            name: none(route.name),
            sourceId: none(route.sourceId),
            kind: none(route.kind),
          },
        };
      },
      updateRoute: async (input) => {
        const route = await updateRoute({
          id: input.id,
          name: input.name,
          sourceType: input.sourceType as
            | NotificationRouteSourceType
            | undefined,
          sourceId: input.sourceId,
          kind: input.kind,
          targetType: input.targetType as 'group' | 'destination' | undefined,
          targetId: input.targetId,
          enabled: input.enabled,
        });
        return {
          route: {
            ...route,
            name: none(route.name),
            sourceId: none(route.sourceId),
            kind: none(route.kind),
          },
        };
      },
      deleteRoute: async (input) => {
        await deleteRoute(input.id);
        return {};
      },

      listResponseRoutes: async (input) => {
        const page = await listResponseRoutes({
          cursor: input.cursor || undefined,
          limit: input.limit || undefined,
        });
        return {
          routes: page.routes.map(responseRoute),
          nextCursor: none(page.nextCursor),
        };
      },
      createResponseRoute: async (input) => {
        if (Boolean(input.destinationId) === input.agent) {
          throw publicApiError(
            'BAD_REQUEST',
            'Set exactly one of destination_id and agent.',
          );
        }
        if (!input.agent && (input.agentSessionId || input.agentInstructions)) {
          throw publicApiError(
            'BAD_REQUEST',
            'agent_session_id and agent_instructions need agent.',
          );
        }
        return {
          route: responseRoute(
            await createResponseRoute({
              name: input.name,
              sourceType: input.sourceType as NotificationRouteSourceType,
              sourceId: input.sourceId,
              kind: input.kind,
              target: input.agent
                ? {
                    agent: {
                      sessionId: input.agentSessionId || null,
                      instructions: input.agentInstructions || null,
                    },
                  }
                : { destinationId: input.destinationId! },
              enabled: input.enabled,
            }),
          ),
        };
      },
      updateResponseRoute: async (input) => ({
        route: responseRoute(
          await updateResponseRoute({
            id: input.id,
            name: input.name,
            sourceType: input.sourceType as
              | NotificationRouteSourceType
              | undefined,
            sourceId: input.sourceId,
            kind: input.kind,
            target: agentOrDestination(input),
            enabled: input.enabled,
          }),
        ),
      }),
      deleteResponseRoute: async (input) => {
        await deleteResponseRoute(input.id);
        return {};
      },

      listChannels: async () => ({
        channels: (await listChannels()).map(channel),
      }),
      createChannel: async (input) => {
        const created = await createChannel({
          name: input.name,
          description: input.description,
          kinds: kindInput(input.kinds?.kinds ?? []),
        });
        return { channel: channel(created.channel), token: created.token };
      },
      updateChannel: async (input) => ({
        channel: channel(
          await updateChannel({
            id: input.id,
            name: input.name,
            description: input.description,
            kinds: input.kinds ? kindInput(input.kinds.kinds) : undefined,
            enabled: input.enabled,
          }),
        ),
      }),
      rotateChannelToken: async (input) => ({
        token: await rotateChannelToken(input.id),
      }),
      deleteChannel: async (input) => {
        await deleteChannel(input.id);
        return {};
      },
    },
    // Every credential has full authority here, like the rest of the public
    // API; only device registration needs a native login session.
    { readMaxBytes: NOTIFICATION_RPC_BODY_LIMIT },
  );
}
