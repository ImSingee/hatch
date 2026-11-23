import { queryOptions } from '@tanstack/react-query';
import { getAgentPreferenceSettings } from '~server/agent-preference-settings';

export const agentPreferencesQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'agent-preferences'],
    queryFn: async () => {
      const settings = await getAgentPreferenceSettings();
      if (settings.userId !== userId)
        throw new Error('Your account changed. Reload the page to continue.');
      return settings;
    },
  });
