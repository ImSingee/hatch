/**
 * Server-only: which configured model serves an App's AI role. The owner's
 * binding wins; an unbound role uses the default model of its kind, the same
 * one a new Agent chat (chat roles) or an icon generation (image roles) uses.
 */
import { db } from '~/db';
import type { RunModelConfig } from '~agent/protocol';
import type { AiRole } from '~server/apps/manifest';
import { listAgentModels } from '~server/agent-model-catalog';
import { AppError } from '~server/errors';
import type { ImageDriver, ImageProvider } from '~server/images/drivers';
import { listImageModels, resolveImageModel } from '~server/images/model';
import { chatModelConfig } from '~server/model-resolution';
import { AiCallError } from './contract';

export type ResolvedChatRole = {
  kind: 'chat';
  config: RunModelConfig;
};

export type ResolvedImageRole = {
  kind: 'image';
  providerName: string;
  modelId: string;
  driver: ImageDriver;
  provider: ImageProvider;
};

async function bindingFor(appId: string, role: string) {
  return db.query.appAiRoleBindings.findFirst({
    where: { appId, role },
    columns: { modelRowId: true },
  });
}

/** Resolve the model for one call, with the provider key. Never returned to Apps. */
export async function resolveChatRole(
  appId: string,
  role: AiRole,
): Promise<ResolvedChatRole> {
  const binding = await bindingFor(appId, role.name);
  let modelRowId = binding?.modelRowId;
  if (!modelRowId) {
    const first = (await listAgentModels())[0]?.models[0];
    if (!first)
      throw new AiCallError(
        'ai_no_model',
        'No chat model is configured on the platform.',
      );
    modelRowId = first.id;
  }
  const model = await db.query.agentModels.findFirst({
    where: { id: modelRowId, kind: 'chat', enabled: true },
  });
  const provider = model
    ? await db.query.agentProviders.findFirst({
        where: { id: model.providerId, enabled: true },
      })
    : undefined;
  if (!model || !provider)
    throw new AiCallError(
      'ai_model_unavailable',
      `The model chosen for AI role "${role.name}" is disabled.`,
    );
  return { kind: 'chat', config: chatModelConfig(provider, model, null) };
}

export async function resolveImageRole(
  appId: string,
  role: AiRole,
): Promise<ResolvedImageRole> {
  const binding = await bindingFor(appId, role.name);
  let resolved: Awaited<ReturnType<typeof resolveImageModel>>;
  try {
    resolved = await resolveImageModel(binding?.modelRowId);
  } catch (error) {
    if (error instanceof AppError) {
      throw binding
        ? new AiCallError(
            'ai_model_unavailable',
            `The model chosen for AI role "${role.name}" cannot generate images.`,
          )
        : new AiCallError(
            'ai_no_model',
            'No usable image model is configured on the platform.',
          );
    }
    throw error;
  }
  const row = await db.query.agentModels.findFirst({
    where: { id: resolved.id },
    columns: { providerId: true },
  });
  const provider = row
    ? await db.query.agentProviders.findFirst({
        where: { id: row.providerId },
        columns: { name: true },
      })
    : undefined;
  return {
    kind: 'image',
    providerName: provider?.name ?? '',
    modelId: resolved.modelId,
    driver: resolved.driver,
    provider: resolved.provider,
  };
}

/** A model a role may be bound to, as the settings UI and CLI show it. */
export type AiModelOption = {
  /** `agent_models.id`: what a binding stores. */
  id: string;
  providerName: string;
  /** Model id sent to the provider. */
  modelId: string;
  name: string;
  /** `<provider name>/<model id>`, what the CLI's `--model` accepts. */
  ref: string;
  /** The chat model can reason; always false for image models. */
  reasoning: boolean;
};

/** Models each role kind can use right now, in default order. */
export async function listAiModelOptions(): Promise<{
  chat: AiModelOption[];
  image: AiModelOption[];
}> {
  const [chatProviders, images] = await Promise.all([
    listAgentModels(),
    listImageModels(),
  ]);
  const chat = chatProviders.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      providerName: provider.name,
      modelId: model.modelId,
      name: model.name,
      ref: `${provider.name}/${model.modelId}`,
      reasoning: model.reasoning,
    })),
  );
  const image = images.models
    .filter((model) => model.usable)
    .map((model) => ({
      id: model.id,
      providerName: model.providerName,
      modelId: model.modelId,
      name: model.name,
      ref: `${model.providerName}/${model.modelId}`,
      reasoning: false,
    }));
  return { chat, image };
}
