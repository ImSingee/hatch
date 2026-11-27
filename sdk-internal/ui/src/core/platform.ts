/**
 * Which platform an App runs on, and what that changes in its theme. Pure
 * rules with no `nsh` import: `env.ts` applies them to what NSH and the
 * shell report, and the library's tests check them on their own.
 *
 * An NSH native host reports its OS itself (`platform.os`). The web player
 * always reports `"web"`, so a shell that hosts it in a native app (the
 * Mobile app's WebView) names its platform in `host.params.platform`; a
 * browser names none and keeps the web look, on phones too.
 */

/** The platform an App runs on. */
export type HostPlatform =
  | 'ios'
  | 'android'
  | 'macos'
  | 'windows'
  | 'linux'
  | 'web';

/**
 * The habits the components follow: iOS, Android (Material 3), or the
 * Desk's own look (DESIGN.md) on the web and, until they get their own, on
 * macOS, Windows and Linux. Colours, the accent, the radii scale, icons and
 * content stay the theme's on every look.
 */
export type Look = 'ios' | 'android' | 'web';

/** The platforms a web shell may name in `host.params.platform`. */
const SHELL_PLATFORMS: readonly string[] = ['ios', 'android'];

/** The platform from NSH's OS and the shell's launch parameters. */
export function resolvePlatform(
  os: string,
  params: Readonly<Record<string, unknown>>,
): HostPlatform {
  if (os !== 'web') {
    return (['ios', 'android', 'macos', 'windows', 'linux'] as const).includes(
      os as never,
    )
      ? (os as HostPlatform)
      : 'web';
  }
  const named = params.platform;
  return typeof named === 'string' && SHELL_PLATFORMS.includes(named)
    ? (named as HostPlatform)
    : 'web';
}

/** The look of a platform. */
export function lookOf(platform: string): Look {
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

type ThemeDocument = {
  cssVars: { theme: Record<string, string | number>; [key: string]: unknown };
};

/** The theme's default face (`tokens.fonts.sans`) and the first family of
 * its `system` stack (`theme/build.ts`): both mean "no face of its own", so
 * on iOS and Android the App takes the platform's font. */
const PLATFORM_DEFAULT_FACES = ['Nunito', 'PingFang SC'];

/** The platform's own font, with the CJK faces after it. */
const PLATFORM_SANS: Record<Exclude<Look, 'web'>, string> = {
  // SF Pro: the system font, which WebKit and NSH's iOS host draw for
  // `system-ui`.
  ios: 'system-ui, -apple-system, PingFang SC, sans-serif',
  android: 'Roboto, Noto Sans SC, system-ui, sans-serif',
};

/** The radii of a platform's signature shapes, which the theme's radius
 * scale does not set: iOS's sheet corner and Material's bottom sheet. */
const PLATFORM_RADII: Record<Exclude<Look, 'web'>, Record<string, string>> = {
  ios: { 'radius-sheet': '24px' },
  android: { 'radius-sheet': '28px' },
};

/**
 * The theme an App applies on `look`. On iOS and Android it gains the
 * platform's signature radii, and a theme without a face of its own draws
 * with the platform's font (SF Pro, Roboto); a face the theme names stays.
 * The web takes the theme as it is.
 */
export function platformTheme<T extends ThemeDocument>(
  theme: T,
  look: Look,
): T {
  if (look === 'web') return theme;
  const sans = theme.cssVars.theme['font-sans'];
  const first = typeof sans === 'string' ? sans.split(',')[0].trim() : '';
  return {
    ...theme,
    cssVars: {
      ...theme.cssVars,
      theme: {
        ...theme.cssVars.theme,
        ...PLATFORM_RADII[look],
        ...(PLATFORM_DEFAULT_FACES.includes(first)
          ? { 'font-sans': PLATFORM_SANS[look] }
          : {}),
      },
    },
  };
}
