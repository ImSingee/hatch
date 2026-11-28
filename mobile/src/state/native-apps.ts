import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { appRuntime } from '../native/app-runtime';
import { openSurfaceLink } from './deep-links';
import { useSession, vault } from './session';

let subscribed = false;

/** Once per process: Apps asking to open other Apps go through the link inbox. */
function subscribe() {
  if (subscribed || !appRuntime.available) return;
  subscribed = true;
  appRuntime.addListener('onOpenApp', ({ slug, route }) =>
    openSurfaceLink({
      instance: null,
      target: { kind: 'app', slug, hash: route || undefined },
    }),
  );
}

/**
 * Hands the native App runtime what it needs from the session: the instance
 * and its credential, the user's background minutes and the theme Apps
 * follow. Used by the App screen; signing out or switching instances stops
 * every App (`SessionProvider`).
 *
 * Returns whether the runtime has this session's credential yet: a view
 * mounted before that would find no session and fail.
 */
export function useNativeAppRuntime(): boolean {
  const { api, origin, epoch } = useSession();
  const session = origin ? `${epoch}:${origin}` : null;
  const [configured, setConfigured] = useState<string | null>(null);
  useEffect(() => {
    subscribe();
    if (!origin) return;
    let alive = true;
    void vault
      .get(origin)
      .then(async (token) => {
        if (!alive) return;
        await appRuntime.configure(origin, token);
        if (alive) setConfigured(`${epoch}:${origin}`);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [origin, epoch]);
  const minutes = useQuery({
    queryKey: [origin, 'desk-preferences', 'background-minutes'],
    queryFn: ({ signal }) => api!.backgroundAppMinutes(signal),
    enabled: Boolean(api && appRuntime.available),
    staleTime: 60_000,
  });
  useEffect(() => {
    if (minutes.data) appRuntime.setBackgroundMinutes(minutes.data);
  }, [minutes.data]);
  // Reads the app's own theme query (`UserTheme` fetches it); never fetches.
  const theme = useQuery({
    queryKey: [origin, 'theme'],
    queryFn: ({ signal }) => api!.theme(signal),
    enabled: false,
  });
  useEffect(() => {
    if (theme.data) appRuntime.setTheme(theme.data);
  }, [theme.data]);
  return session !== null && configured === session;
}
