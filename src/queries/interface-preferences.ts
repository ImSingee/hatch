import { queryOptions } from '@tanstack/react-query';
import { getInterfacePreferenceSettings } from '~server/interface-preference-settings';

export const interfacePreferencesQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'interface-preferences'],
    queryFn: async () => {
      const settings = await getInterfacePreferenceSettings();
      if (settings.userId !== userId)
        throw new Error('Your account changed. Reload the page to continue.');
      return settings;
    },
  });
