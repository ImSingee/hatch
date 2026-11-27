import { AccountChangedError, retryUnlessAccountChanged } from './account';
import { queryOptions } from '@tanstack/react-query';
import { getInterfacePreferenceSettings } from '~server/interface-preference-settings';

export const interfacePreferencesQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'interface-preferences'],
    retry: retryUnlessAccountChanged,
    queryFn: async () => {
      const settings = await getInterfacePreferenceSettings();
      if (settings.userId !== userId) throw new AccountChangedError();
      return settings;
    },
  });
