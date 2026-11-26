import { queryOptions } from '@tanstack/react-query';
import { getDeskPreferenceSettings } from '~server/desk-preference-settings';

/** The signed-in user's Desk preferences (how long minimised Apps run). */
export const deskPreferencesQueryOptions = queryOptions({
  queryKey: ['account', 'desk-preferences'],
  queryFn: () => getDeskPreferenceSettings(),
});
