import { useQuery } from '@tanstack/react-query';
import { File, Paths } from 'expo-file-system';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { Appearance, useColorScheme } from 'react-native';
import {
  THEME_MODES,
  isResolvedTheme,
} from '../../../packages/hatch-design-tokens/src';
import type { InstanceTheme as Theme } from '../core/client';
import { ThemeProvider } from '../ui/theme-context';
import { BUILT_IN_THEMES, mobileThemeOf } from '../ui/theme';
import { useSession } from './session';

/** Resolved themes are a few kilobytes each: too large for the Keychain. */
const CACHE_FILE = 'instance-theme-v1.json';

const BUILT_IN: Theme = { mode: 'light', ...BUILT_IN_THEMES };

function cacheFile(): File {
  return new File(Paths.document, CACHE_FILE);
}

/** Each origin's last theme from the cache file, dropping anything stale. */
export function parseThemeCache(raw: string): Record<string, Theme> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, Partial<Theme>>).filter(
      ([, theme]) =>
        (THEME_MODES as readonly unknown[]).includes(theme?.mode) &&
        isResolvedTheme(theme?.light, 'light') &&
        isResolvedTheme(theme?.dark, 'dark'),
    ),
  ) as Record<string, Theme>;
}

function readCache(): Record<string, Theme> {
  try {
    const file = cacheFile();
    return file.exists ? parseThemeCache(file.textSync()) : {};
  } catch {
    // An unreadable cache only means the built-in theme until the answer.
    return {};
  }
}

/**
 * The instance's theme (`ui.theme`, resolved by ThemeService) as the app's
 * theme. The last answer is kept on the phone, per instance, and drawn from
 * the first frame of a cold start; the instance is asked again on sign-in
 * and whenever the app returns to the foreground. Signed out, or before an
 * instance has answered once, the built-in `desk` themes apply. The mode
 * also sets the app's system appearance, so native controls, the status bar
 * and web pages (`prefers-color-scheme`) match.
 */
export function InstanceTheme({ children }: PropsWithChildren) {
  const { api, origin } = useSession();
  // Read once at launch; `stored` is what is written back.
  const [cached] = useState(readCache);
  const stored = useRef<Record<string, Theme>>(cached);
  const theme = useQuery({
    queryKey: [origin, 'theme'],
    queryFn: async ({ signal }) => {
      const next = await api!.theme(signal);
      if (origin) {
        stored.current = { ...stored.current, [origin]: next };
        cacheFile()
          .write(JSON.stringify(stored.current))
          .catch(() => undefined);
      }
      return next;
    },
    enabled: Boolean(api),
    // Refetched on foreground through the query focus manager.
    staleTime: 0,
  });
  const current =
    theme.data ?? (origin ? cached[origin] : undefined) ?? BUILT_IN;

  useEffect(() => {
    // `unspecified` follows the device again.
    Appearance.setColorScheme(
      current.mode === 'system' ? 'unspecified' : current.mode,
    );
  }, [current.mode]);
  useEffect(() => () => Appearance.setColorScheme('unspecified'), []);

  const device = useColorScheme();
  const appearance =
    current.mode === 'system'
      ? device === 'dark'
        ? 'dark'
        : 'light'
      : current.mode;
  const resolved = current[appearance];
  const mobile = useMemo(() => mobileThemeOf(resolved), [resolved]);
  return <ThemeProvider theme={mobile}>{children}</ThemeProvider>;
}
