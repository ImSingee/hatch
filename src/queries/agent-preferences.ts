import { AccountChangedError, retryUnlessAccountChanged } from './account';
import { queryOptions } from '@tanstack/react-query';
import { getAgentPreferenceSettings } from '~server/agent-preference-settings';

export const agentPreferencesQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'agent-preferences'],
    retry: retryUnlessAccountChanged,
    queryFn: async () => {
      const settings = await getAgentPreferenceSettings();
      if (settings.userId !== userId) throw new AccountChangedError();
      return settings;
    },
  });
