import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
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

export const updateAgentPreferenceSettings = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { messageMode: AgentPreferences['messageMode'] }) =>
    z.object({ messageMode: z.enum(['queue', 'steer']) }).parse(input),
  )
  .handler(async ({ data }): Promise<AgentPreferenceSettings> => {
    const { user } = await requireSession();
    return {
      userId: user.id,
      ...(await updateAgentPreferences(user.id, data)),
    };
  });
