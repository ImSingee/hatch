import { useQuery } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AccentProvider } from '../ui/accent';
import { knownAccent } from '../ui/theme';
import { useSession } from './session';

const key = 'accent-v1';
const options = {
  keychainService: 'app.hatch.mobile.preferences',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The instance's accent (`ui.theme`, read through ThemeService) as the app's
 * accent. The last value is kept on the phone, per instance, and shown from
 * the first frame of a cold start; the instance is asked again on sign-in and
 * whenever the app returns to the foreground. Signed out, or before an
 * instance has answered once, the token default applies.
 */
export function InstanceAccent({ children }: PropsWithChildren) {
  const { api, origin } = useSession();
  // What the phone remembered at launch, per instance; drawn until the
  // instance answers. `stored` is what is written back.
  const [cached, setCached] = useState<Record<string, string> | null>(null);
  const stored = useRef<Record<string, string>>({});
  useEffect(() => {
    void SecureStore.getItemAsync(key, options)
      .then((raw) => {
        const value: unknown = raw ? JSON.parse(raw) : null;
        const map =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, string>)
            : {};
        stored.current = { ...map };
        setCached(map);
      })
      // An unreadable cache only means the default until the instance answers.
      .catch(() => setCached({}));
  }, []);
  const theme = useQuery({
    queryKey: [origin, 'theme'],
    queryFn: async ({ signal }) => {
      const accent = await api!.themeAccent(signal);
      // Kept for the next cold start; the read above stays the source.
      if (origin && stored.current[origin] !== accent) {
        stored.current = { ...stored.current, [origin]: accent };
        void SecureStore.setItemAsync(
          key,
          JSON.stringify(stored.current),
          options,
        ).catch(() => undefined);
      }
      return accent;
    },
    // The cache is read first, so a fresh answer can be stored beside it.
    enabled: Boolean(api) && cached !== null,
    // Refetched on foreground through the query focus manager.
    staleTime: 0,
  });
  const fetched = theme.data;
  // Nothing is drawn until the cache is read, so the accent never flashes.
  if (!cached) return null;
  return (
    <AccentProvider
      name={knownAccent(fetched ?? (origin ? cached[origin] : undefined))}
    >
      {children}
    </AccentProvider>
  );
}
