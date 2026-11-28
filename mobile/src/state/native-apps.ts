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
  appRuntime.addListener('onOpenApp', ({ slug, route, origin }) =>
    openSurfaceLink({
      // The App's own instance: the inbox handles another one as any link.
      instance: origin,
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
 * `ready` tells whether the runtime has this session's credential yet: a
 * view mounted before that would find no session. `error` is a credential
 * that could not be read; `retry` reads it again.
 */
export function useNativeAppRuntime() {
  const { api, origin, epoch } = useSession();
  useEffect(subscribe, []);
  const configured = useQuery({
    queryKey: [origin, 'native-app-runtime', epoch],
    queryFn: async ({ signal }) => {
      const token = await vault.get(origin!);
      // Signing out or switching instances cancels this query: a credential
      // read for the session that ended configures nothing.
      if (signal.aborted) throw new Error('The session changed.');
      await appRuntime.configure(origin, token);
      return true;
    },
    enabled: Boolean(origin && appRuntime.available),
    staleTime: Infinity,
    gcTime: 0,
    retry: 1,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
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
  return {
    ready: configured.data === true,
    error: configured.error,
    retry: () => void configured.refetch(),
  };
}
