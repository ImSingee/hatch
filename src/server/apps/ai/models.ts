/**
 * Server-only: which configured model serves an App's AI role. The owner's
 * pick for the role wins; otherwise the platform's default model for Apps of
 * that kind (`apps.aiDefaults`); otherwise the first usable model of that
 * kind in provider and model order.
 */
import { db } from '~/db';
import type { RunModelConfig } from '~agent/protocol';
import type { AiRole } from '~server/apps/manifest';
import { listAgentModels } from '~server/agent-model-catalog';
import { AppError } from '~server/errors';
import type { ImageDriver, ImageProvider } from '~server/images/drivers';
import { listImageModels, resolveImageModel } from '~server/images/model';
import { chatModelConfig } from '~server/model-resolution';
import { getPlatformConfig } from '~server/platform-config';
import { AiCallError } from './contract';

export type AiRoleKind = AiRole['kind'];

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

/** A model a role or the default may be set to, as the UI and CLI show it. */
export type AiModelOption = {
  /** `agent_models.id`: what a pick stores. */
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

/** Models each role kind can use right now, in model order. */
export async function listAiModelOptions(): Promise<
  Record<AiRoleKind, AiModelOption[]>
> {
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

/** Where the model an unpicked role uses came from. */
export type AiDefaultSource = 'setting' | 'order';

/**
 * The default model id of a kind: the configured one while its model row
 * exists (deleting the model clears it), else the first usable model.
 */
export async function defaultModelRowId(
  kind: AiRoleKind,
  options?: Record<AiRoleKind, AiModelOption[]>,
): Promise<{ id: string | null; source: AiDefaultSource }> {
  const defaults = await getPlatformConfig('apps.aiDefaults');
  const configured =
    kind === 'chat' ? defaults.chatModelId : defaults.imageModelId;
  if (configured) {
    const row = await db.query.agentModels.findFirst({
      where: { id: configured, kind },
      columns: { id: true },
    });
    if (row) return { id: row.id, source: 'setting' };
  }
  const list = (options ?? (await listAiModelOptions()))[kind];
  return { id: list[0]?.id ?? null, source: 'order' };
}

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
  const fallback = binding ? null : await defaultModelRowId('chat');
  const modelRowId = binding?.modelRowId ?? fallback?.id;
  if (!modelRowId)
    throw new AiCallError(
      'ai_no_model',
      'No chat model is configured on the platform.',
    );
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
      binding
        ? `The model chosen for AI role "${role.name}" is disabled.`
        : 'The default chat model for Apps is disabled.',
    );
  return { kind: 'chat', config: chatModelConfig(provider, model, null) };
}

export async function resolveImageRole(
  appId: string,
  role: AiRole,
): Promise<ResolvedImageRole> {
  const binding = await bindingFor(appId, role.name);
  const fallback = binding ? null : await defaultModelRowId('image');
  const chosen = binding?.modelRowId ?? fallback?.id ?? null;
  if (!chosen)
    throw new AiCallError(
      'ai_no_model',
      'No usable image model is configured on the platform.',
    );
  let resolved: Awaited<ReturnType<typeof resolveImageModel>>;
  try {
    resolved = await resolveImageModel(chosen);
  } catch (error) {
    if (error instanceof AppError)
      throw new AiCallError(
        'ai_model_unavailable',
        binding
          ? `The model chosen for AI role "${role.name}" cannot generate images.`
          : 'The default image model for Apps cannot generate images.',
      );
    throw error;
  }
  return {
    kind: 'image',
    providerName: resolved.providerName,
    modelId: resolved.modelId,
    driver: resolved.driver,
    provider: resolved.provider,
  };
}
