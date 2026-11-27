import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authClient } from '~auth/client';
import { changeLocale } from '~i18n';
import { interfacePreferencesQueryOptions } from '~queries/interface-preferences';

/**
 * Keeps the UI on the signed-in user's language: applies the saved
 * preference as soon as it is fetched and whenever the query refreshes (a
 * change on another device arrives on the next focus). Without a session, or
 * before the user picks a language, this browser keeps its cached one.
 */
export function LocaleSync() {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  return userId ? <UserLocaleSync key={userId} userId={userId} /> : null;
}

function UserLocaleSync({ userId }: { userId: string }) {
  const { data } = useQuery(interfacePreferencesQueryOptions(userId));
  const language = data?.language;
  useEffect(() => {
    if (language) void changeLocale(language);
  }, [language]);
  return null;
}
