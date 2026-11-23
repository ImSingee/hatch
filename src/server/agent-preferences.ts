/** Server-only: a user's personal Agent preferences. */
import { db, schema } from '~/db';
import type { AgentMessageMode } from '~/db/schema';
import { DEFAULT_HOMEPAGE } from '~/homepage';
import { AppError } from './errors';

export const AGENT_MESSAGE_MODES = ['queue', 'steer'] as const;
export const DEFAULT_AGENT_MESSAGE_MODE: AgentMessageMode = 'steer';

export type AgentPreferences = {
  /** How a message sent while the Agent is working is delivered. */
  messageMode: AgentMessageMode;
};

export function isAgentMessageMode(value: unknown): value is AgentMessageMode {
  return (AGENT_MESSAGE_MODES as readonly unknown[]).includes(value);
}

export async function readAgentPreferences(
  userId: string,
): Promise<AgentPreferences> {
  const row = await db.query.userPreferences.findFirst({
    where: { userId },
    columns: { agentMessageMode: true },
  });
  return {
    messageMode: isAgentMessageMode(row?.agentMessageMode)
      ? row.agentMessageMode
      : DEFAULT_AGENT_MESSAGE_MODE,
  };
}

/** Apply the given fields; omitted fields keep their current value. */
export async function updateAgentPreferences(
  userId: string,
  input: Partial<AgentPreferences>,
): Promise<AgentPreferences> {
  if (input.messageMode === undefined) return readAgentPreferences(userId);
  if (!isAgentMessageMode(input.messageMode)) {
    throw new AppError('Message mode must be "queue" or "steer".', 400);
  }
  const messageMode = input.messageMode;
  await db
    .insert(schema.userPreferences)
    // A first preference row needs a homepage; the default is what the
    // user already gets without one.
    .values({
      userId,
      homepage: DEFAULT_HOMEPAGE,
      agentMessageMode: messageMode,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { agentMessageMode: messageMode, updatedAt: new Date() },
    });
  return { messageMode };
}
