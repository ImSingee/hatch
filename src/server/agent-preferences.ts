/** Server-only: a user's personal Agent preferences. */
import { db, schema } from '~/db';
import type { AgentMessageMode, AgentModelPreference } from '~/db/schema';
import { DEFAULT_HOMEPAGE } from '~/homepage';
import { assertSelectableModel } from './agent-model-catalog';
import { AppError } from './errors';

export const AGENT_MESSAGE_MODES = ['queue', 'steer'] as const;
export const DEFAULT_AGENT_MESSAGE_MODE: AgentMessageMode = 'steer';

export type AgentPreferences = {
  /** How a message sent while the Agent is working is delivered. */
  messageMode: AgentMessageMode;
  /**
   * The model new chats start with, as saved. It may name a model that has
   * since been removed; the model catalog then falls back to the first one.
   */
  defaultModel: AgentModelPreference | null;
};

export type AgentPreferencesUpdate = {
  messageMode?: AgentMessageMode;
  /** Replaces the default model; null clears it. */
  defaultModel?: AgentModelPreference | null;
};

export function isAgentMessageMode(value: unknown): value is AgentMessageMode {
  return (AGENT_MESSAGE_MODES as readonly unknown[]).includes(value);
}

export async function readAgentPreferences(
  userId: string,
): Promise<AgentPreferences> {
  const row = await db.query.userPreferences.findFirst({
    where: { userId },
    columns: { agentMessageMode: true, agentModel: true },
  });
  return {
    messageMode: isAgentMessageMode(row?.agentMessageMode)
      ? row.agentMessageMode
      : DEFAULT_AGENT_MESSAGE_MODE,
    defaultModel: row?.agentModel ?? null,
  };
}

/** Apply the given fields; omitted fields keep their current value. */
export async function updateAgentPreferences(
  userId: string,
  input: AgentPreferencesUpdate,
): Promise<AgentPreferences> {
  const set: Partial<typeof schema.userPreferences.$inferInsert> = {};
  if (input.messageMode !== undefined) {
    if (!isAgentMessageMode(input.messageMode))
      throw new AppError('Message mode must be "queue" or "steer".', 400);
    set.agentMessageMode = input.messageMode;
  }
  if (input.defaultModel !== undefined) {
    if (input.defaultModel) {
      await assertSelectableModel(input.defaultModel);
      const { providerId, modelId, thinkingLevel } = input.defaultModel;
      set.agentModel = {
        providerId,
        modelId,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      };
    } else {
      set.agentModel = null;
    }
  }
  if (!Object.keys(set).length) return readAgentPreferences(userId);
  await db
    .insert(schema.userPreferences)
    // A first preference row needs a homepage; the default is what the
    // user already gets without one.
    .values({ userId, homepage: DEFAULT_HOMEPAGE, ...set })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { ...set, updatedAt: new Date() },
    });
  return readAgentPreferences(userId);
}
