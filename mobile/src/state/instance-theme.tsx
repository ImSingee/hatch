import { useQuery } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { Appearance } from 'react-native';
import {
  BUILT_IN_THEME,
  isResolvedTheme,
  type ResolvedTheme,
} from '../../../packages/hatch-design-tokens/src';
import { ThemeProvider } from '../ui/theme-context';
import { mobileThemeOf } from '../ui/theme';
import { useSession } from './session';

/** Resolved themes are a few kilobytes each: too large for the Keychain. */
const CACHE_FILE = 'instance-theme-v2.json';

function cacheFile(): File {
  return new File(Paths.document, CACHE_FILE);
}

/** Each origin's last theme from the cache file, dropping anything stale. */
export function parseThemeCache(raw: string): Record<string, ResolvedTheme> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, theme]) =>
      isResolvedTheme(theme),
    ),
  ) as Record<string, ResolvedTheme>;
}

function readCache(): Record<string, ResolvedTheme> {
  try {
    const file = cacheFile();
    return file.exists ? parseThemeCache(file.textSync()) : {};
  } catch {
    // An unreadable cache only means the built-in theme until the answer.
    return {};
  }
}

/**
 * The instance's active theme (`ui.theme`, resolved by ThemeService) as the
 * app's theme. The last answer is kept on the phone, per instance, and drawn
 * from the first frame of a cold start; the instance is asked again on
 * sign-in and whenever the app returns to the foreground. Signed out, or
 * before an instance has answered once, the built-in `desk` applies. The
 * theme's appearance also sets the app's system appearance, so native
 * controls, the status bar and web pages match it whatever the device's own
 * setting is.
 */
export function InstanceTheme({ children }: PropsWithChildren) {
  const { api, origin } = useSession();
  // Each instance's last answer: read from the file once at launch, then
  // updated on every answer, so switching back to an instance draws its
  // latest theme even before (or without) a new answer.
  const [cache, setCache] = useState(readCache);
  const launched = useRef(cache);
  useEffect(() => {
    if (cache === launched.current) return;
    cacheFile()
      .write(JSON.stringify(cache))
      .catch(() => undefined);
  }, [cache]);
  const theme = useQuery({
    queryKey: [origin, 'theme'],
    queryFn: async ({ signal }) => {
      const next = await api!.theme(signal);
      if (origin) setCache((current) => ({ ...current, [origin]: next }));
      return next;
    },
    enabled: Boolean(api),
    // Refetched on foreground through the query focus manager.
    staleTime: 0,
  });
  const resolved =
    theme.data ?? (origin ? cache[origin] : undefined) ?? BUILT_IN_THEME;

  useEffect(() => {
    Appearance.setColorScheme(resolved.appearance);
  }, [resolved.appearance]);
  useEffect(() => () => Appearance.setColorScheme('unspecified'), []);

  const mobile = useMemo(() => mobileThemeOf(resolved), [resolved]);
  return <ThemeProvider theme={mobile}>{children}</ThemeProvider>;
}
