import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authClient } from '~auth/client';
import { themeQueryOptions } from '~queries/theme';
import { applyThemeState } from '~ui/theme';

/**
 * Keeps this browser on the signed-in user's theme: applies it as soon as it
 * is fetched and whenever the query refreshes. Without a session (the
 * sign-in page) the theme this browser showed last stays.
 */
export function ThemeSync() {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  return userId ? <UserThemeSync key={userId} userId={userId} /> : null;
}

function UserThemeSync({ userId }: { userId: string }) {
  const { data } = useQuery(themeQueryOptions(userId));
  useEffect(() => {
    if (data) applyThemeState({ accent: data.accent, theme: data.resolved });
  }, [data]);
  return null;
}
