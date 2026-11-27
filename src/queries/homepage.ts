import { AccountChangedError, retryUnlessAccountChanged } from './account';
import { queryOptions } from '@tanstack/react-query';
import { getHomepageSettings } from '~server/homepage';

export const homepageSettingsQueryOptions = (userId: string) =>
  queryOptions({
    queryKey: ['account', userId, 'homepage'],
    retry: retryUnlessAccountChanged,
    queryFn: async () => {
      const settings = await getHomepageSettings();
      if (settings.userId !== userId) throw new AccountChangedError();
      return settings;
    },
  });
