import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
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
 */
export function useNativeAppRuntime(): void {
  const { api, origin, epoch } = useSession();
  useEffect(() => {
    subscribe();
    if (!origin) return;
    let alive = true;
    void vault.get(origin).then((token) => {
      if (alive) appRuntime.configure(origin, token);
    });
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
}
