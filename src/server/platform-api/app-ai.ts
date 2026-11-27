/** Server-only: AppService AI RPC messages from the App AI domain views. */
import type { AiModelOption } from '~server/apps/ai/models';
import type {
  AiDefaultView,
  AppAiDefaultsView,
  AppAiUsageItem,
  AppAiUsageSummaryRow,
  AppAiView,
} from '~server/apps/ai/settings';

const modelMessage = (model: AiModelOption) => ({
  id: model.id,
  providerName: model.providerName,
  modelId: model.modelId,
  name: model.name,
  ref: model.ref,
  reasoning: model.reasoning,
});

export function appAiMessage(view: AppAiView) {
  return {
    appId: view.appId,
    available: view.available,
    roles: view.roles.map((role) => ({
      name: role.name,
      kind: role.kind,
      description: role.description,
      needs: role.needs,
      model: role.model ? modelMessage(role.model) : undefined,
      bound: role.bound,
      unavailable: role.unavailable,
      missingNeeds: role.missingNeeds,
      defaultSource: role.defaultSource ?? undefined,
    })),
    chatModels: view.models.chat.map(modelMessage),
    imageModels: view.models.image.map(modelMessage),
  };
}

const defaultMessage = (view: AiDefaultView) => ({
  model: view.model ? modelMessage(view.model) : undefined,
  source: view.source,
  unavailable: view.unavailable,
});

export function appAiDefaultsMessage(view: AppAiDefaultsView) {
  return {
    chat: defaultMessage(view.chat),
    image: defaultMessage(view.image),
    chatModels: view.models.chat.map(modelMessage),
    imageModels: view.models.image.map(modelMessage),
  };
}

export function appAiCallMessage(call: AppAiUsageItem) {
  return { ...call, errorCode: call.errorCode ?? undefined };
}

export function appAiTotalMessage(row: AppAiUsageSummaryRow) {
  return {
    ...row,
    inputTokens: BigInt(row.inputTokens),
    outputTokens: BigInt(row.outputTokens),
  };
}
