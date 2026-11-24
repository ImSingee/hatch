import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
import { THINKING_LEVELS } from './model-catalog/types';
import {
  readAgentPreferences,
  updateAgentPreferences,
  type AgentPreferences,
} from './agent-preferences';

export type AgentPreferenceSettings = AgentPreferences & { userId: string };

export const getAgentPreferenceSettings = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AgentPreferenceSettings> => {
    const { user } = await requireSession();
    return { userId: user.id, ...(await readAgentPreferences(user.id)) };
  });

const updateSchema = z.object({
  messageMode: z.enum(['queue', 'steer']).optional(),
  /** Replaces the default model; null clears it. */
  defaultModel: z
    .object({
      providerId: z.string().min(1).max(200),
      modelId: z.string().min(1).max(200),
      thinkingLevel: z.enum(THINKING_LEVELS).optional(),
    })
    .nullable()
    .optional(),
});

export const updateAgentPreferenceSettings = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: z.input<typeof updateSchema>) => updateSchema.parse(input))
  .handler(async ({ data }): Promise<AgentPreferenceSettings> => {
    const { user } = await requireSession();
    return {
      userId: user.id,
      ...(await updateAgentPreferences(user.id, data)),
    };
  });
