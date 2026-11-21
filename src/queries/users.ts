import { queryOptions } from '@tanstack/react-query';
import { getSpaceSummary } from '~server/space';
import { getSignupConfig, getUsersPanelData } from '~server/users';

export const usersPanelQueryOptions = queryOptions({
  queryKey: ['settings', 'users'],
  queryFn: () => getUsersPanelData(),
});

/** Public probe used by the login page to decide whether to offer sign-up. */
export const signupConfigQueryOptions = queryOptions({
  queryKey: ['auth', 'signup-config'],
  queryFn: () => getSignupConfig(),
});

/** The instance's display name for the menu bar; it changes rarely. */
export const spaceQueryOptions = queryOptions({
  queryKey: ['space'],
  queryFn: () => getSpaceSummary(),
  staleTime: 5 * 60_000,
});
