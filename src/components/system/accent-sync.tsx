import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authClient } from '~auth/client';
import { themeQueryOptions } from '~queries/theme';
import { applyAccent } from '~ui/theme';

/**
 * Keeps this browser on the signed-in user's accent: applies it as soon as it
 * is fetched and whenever the query refreshes. Without a session (the login
 * page) the accent this browser showed last stays.
 */
export function AccentSync() {
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  return userId ? <UserAccentSync key={userId} userId={userId} /> : null;
}

function UserAccentSync({ userId }: { userId: string }) {
  const { data } = useQuery(themeQueryOptions(userId));
  const accent = data?.accent;
  useEffect(() => {
    if (accent) applyAccent(accent);
  }, [accent]);
  return null;
}
