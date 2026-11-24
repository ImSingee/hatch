/** Normalize Protobuf presence for the existing UI without importing server code. */
import { toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  answersFromMessages,
  replyFromMessage,
  type Resource,
  type AgentSession,
  type AgentSessionSummary,
  type GetModelCatalogResponse,
  type NotificationDetail as RpcNotificationDetail,
  type NotificationSummary as RpcNotificationSummary,
} from '@hatch/platform-api';
import { MobileError } from './security';
import type {
  AppSummary,
  AgentModelCatalog,
  NotificationDetail,
  NotificationSummary,
  RunStatus,
  SessionDetail,
  SessionSummary,
} from './types';

export function appProjection(app: Resource): AppSummary {
  return {
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description ?? null,
    status: app.status,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    iconPath: app.iconPath ?? null,
    live: hasLiveVersion(app),
  };
}
/** The view names the live deployment's version as `currentVersion`. */
function hasLiveVersion(app: Resource) {
  const view = app.view ? toJson(ValueSchema, app.view) : null;
  if (!view || typeof view !== 'object' || Array.isArray(view)) return false;
  return typeof view.currentVersion === 'number';
}
export function summaryProjection(
  session: AgentSessionSummary,
): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    appIds: session.appIds,
    providerId: session.providerId ?? null,
    modelId: session.modelId ?? null,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt,
  };
}
function runStatus(value: string): RunStatus {
  switch (value) {
    case 'running':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return value;
    default:
      throw new MobileError(
        'invalid_response',
        'The instance returned an unsupported run status.',
      );
  }
}
export function sessionProjection(session: AgentSession): SessionDetail {
  const active = session.activeRun;
  return {
    id: session.id,
    title: session.title,
    appIds: session.appIds,
    providerId: session.providerId ?? null,
    modelId: session.modelId ?? null,
    updatedAt: session.updatedAt,
    serverTime: session.serverTime,
    messages: session.messages.map((message) => toJson(ValueSchema, message)),
    pending: {
      paused: session.pending?.paused ?? false,
      messages: (session.pending?.messages ?? []).map((message) => ({
        id: message.id,
        mode: message.mode === 'queue' ? 'queue' : 'steer',
        status:
          message.status === 'claimed' || message.status === 'sending'
            ? message.status
            : 'pending',
        content: message.content.map((part) => toJson(ValueSchema, part)),
        text: message.text,
        images: message.images.map((image) => ({
          data: image.data,
          mimeType: image.mimeType,
        })),
        attachments: message.attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
        })),
        providerId: message.providerId,
        modelId: message.modelId,
      })),
    },
    activeRun: active
      ? {
          id: active.id,
          status: runStatus(active.status),
          startedAt: active.startedAt,
          userTurn: active.userTurn ?? null,
          pendingAsk: active.pendingAsk
            ? {
                askId: active.pendingAsk.askId,
                questions: active.pendingAsk.questions.map((question) => ({
                  id: question.id,
                  prompt: question.prompt,
                  allowMultiple: question.allowMultiple,
                  options: question.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                  })),
                })),
              }
            : null,
          answeredAskId: active.answeredAskId ?? null,
          pendingEnvRequest: active.pendingEnvRequest
            ? {
                requestId: active.pendingEnvRequest.requestId,
                reason: active.pendingEnvRequest.reason,
                variables: active.pendingEnvRequest.variables.map(
                  (variable) => ({
                    key: variable.key,
                    description: variable.description,
                    secret: variable.secret,
                  }),
                ),
              }
            : null,
        }
      : null,
    runs: session.runs.map((run) => ({
      id: run.id,
      status: runStatus(run.status),
      userTurn: run.userTurn,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? null,
      error: run.error ?? null,
    })),
  };
}
export function catalogProjection(
  catalog: GetModelCatalogResponse,
): AgentModelCatalog {
  return {
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      catalogProviderId: provider.catalogProviderId,
      models: provider.models.map((model) => ({
        id: model.id,
        modelId: model.modelId,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevels: model.thinkingLevels,
        defaultThinkingLevel: model.defaultThinkingLevel,
      })),
    })),
    defaultModel: catalog.defaultModel
      ? {
          providerId: catalog.defaultModel.providerId,
          modelId: catalog.defaultModel.modelId,
          thinkingLevel: catalog.defaultModel.thinkingLevel,
        }
      : null,
  };
}

export function notificationSummaryProjection(
  value: RpcNotificationSummary,
): NotificationSummary {
  return {
    id: value.id,
    sourceType: value.sourceType,
    sourceName: value.sourceName,
    kind: value.kind,
    kindName: value.kindName,
    title: value.title,
    body: value.body ?? null,
    url: value.url ?? null,
    occurredAt: value.occurredAt,
    status: value.status,
    priority: value.priority,
    editedAt: value.editedAt ?? null,
    recalledAt: value.recalledAt ?? null,
    reply: value.reply ? replyFromMessage(value.reply) : null,
    respondedAt: value.respondedAt ?? null,
  };
}
export function notificationDetailProjection(
  value: RpcNotificationDetail,
): NotificationDetail {
  if (!value.summary)
    throw new MobileError(
      'invalid_response',
      'The instance returned no notification.',
    );
  return {
    ...notificationSummaryProjection(value.summary),
    deliveries: value.deliveries.map((delivery) => ({
      id: delivery.id,
      destinationType: delivery.destinationType,
      destinationName: delivery.destinationName,
      status: delivery.status,
      attempts: delivery.attempts,
      lastError: delivery.lastError ?? null,
      result: delivery.result ?? null,
      completedAt: delivery.completedAt ?? null,
    })),
    response: value.response
      ? {
          answers: answersFromMessages(value.response.answers),
          respondedByName: value.response.respondedByName,
          via: value.response.via,
          respondedAt: value.response.respondedAt,
        }
      : null,
  };
}
