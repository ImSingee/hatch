/**
 * Which platform's look an App takes, and the font it then draws with. Pure
 * rules of `src/core/platform.ts`; `fixtures/platform` checks them in NSH.
 */
import { describe, expect, it } from 'vitest';
import { resolvePreset } from '../../../packages/hatch-design-tokens/src/index.ts';
import { BUNDLED_FONTS } from '../../../packages/hatch-design-tokens/src/theme.ts';
import { CONTRAST_PAIRS } from '../../../packages/hatch-design-tokens/src/validate.ts';
import tokens from '../../../packages/hatch-design-tokens/tokens.json' with { type: 'json' };
import {
  lookOf,
  platformTheme,
  resolvePlatform,
} from '../src/core/platform.ts';
import { buildAppTheme } from '../theme/build.ts';

describe('the platform an App runs on', () => {
  it('is the OS NSH reports outside the web', () => {
    expect(resolvePlatform('ios', {})).toBe('ios');
    expect(resolvePlatform('android', { platform: 'ios' })).toBe('android');
    expect(resolvePlatform('macos', { platform: 'ios' })).toBe('macos');
  });

  it('is the one the web shell passes in host.params', () => {
    expect(resolvePlatform('web', { platform: 'ios' })).toBe('ios');
    expect(resolvePlatform('web', { platform: 'android' })).toBe('android');
  });

  it('is the web in a browser and for anything else the shell passes', () => {
    for (const platform of [undefined, '', 'windows', 'IOS', 7, null])
      expect(resolvePlatform('web', { platform })).toBe('web');
  });

  it('draws macOS, Windows and Linux with the web look for now', () => {
    expect(
      ['ios', 'android', 'macos', 'windows', 'linux', 'web'].map(lookOf),
    ).toEqual(['ios', 'android', 'web', 'web', 'web', 'web']);
  });
});

/** The first family of a theme's sans stack. */
const sans = (theme: ReturnType<typeof buildAppTheme>) =>
  theme.cssVars.theme['font-sans'].split(',')[0].trim();

const withSans = (face: string) => {
  const theme = resolvePreset('desk', tokens.accents.indigo);
  return buildAppTheme({
    theme: { ...theme, fonts: { ...theme.fonts, sans: face } },
  });
};

describe('the font an App draws with', () => {
  it('is the platform font for every bundled sans choice on iOS and Android', () => {
    for (const face of BUNDLED_FONTS.sans) {
      expect(sans(platformTheme(withSans(face), 'ios'))).toBe('system-ui');
      expect(sans(platformTheme(withSans(face), 'android'))).toBe('Roboto');
    }
  });

  it('is the theme font on the web', () => {
    for (const face of BUNDLED_FONTS.sans) {
      const theme = withSans(face);
      expect(platformTheme(theme, 'web')).toEqual(theme);
    }
    expect(sans(buildAppTheme())).toBe('Nunito');
  });

  it('is a face the theme names besides the default one everywhere', () => {
    const theme = withSans('JetBrains Mono');
    for (const look of ['ios', 'android'] as const)
      expect(platformTheme(theme, look).cssVars.theme['font-sans']).toBe(
        theme.cssVars.theme['font-sans'],
      );
  });
});

describe('the platform theme', () => {
  it("adds the platform's sheet radius and keeps every other token", () => {
    const theme = buildAppTheme();
    for (const [look, radius] of [
      ['ios', '24px'],
      ['android', '28px'],
    ] as const) {
      const platform = platformTheme(theme, look);
      const {
        'font-sans': _,
        'radius-sheet': sheet,
        ...rest
      } = platform.cssVars.theme;
      const {
        'font-sans': __,
        'radius-sheet': ___,
        ...before
      } = theme.cssVars.theme;
      expect(sheet).toBe(radius);
      expect(rest).toEqual(before);
      expect(platform.cssVars.light).toEqual(theme.cssVars.light);
    }
  });
});

/**
 * The text colours the iOS and Android looks draw at rest, on the fills
 * they draw them on (pressed and hover overlays aside). Each pair must be
 * one the theme validation checks (`CONTRAST_PAIRS`), so every theme that
 * can be saved reads at 4.5:1 on both looks.
 */
const PLATFORM_TEXT_PAIRS: readonly (readonly [string, string])[] = [
  // Pages, large titles, top app bars, list and field text.
  ['foreground', 'background'],
  ['muted-foreground', 'background'],
  ['foreground', 'card'],
  ['muted-foreground', 'card'],
  // Android's navigation bar.
  ['foreground', 'muted'],
  ['muted-foreground', 'muted'],
  // iOS's back and Cancel, plain and text buttons, Android's focused label.
  ['primary-strong', 'background'],
  ['primary-strong', 'card'],
  // Filled, tonal and gray buttons, the selected tab's pill.
  ['primary-foreground', 'primary'],
  ['primary-tint-foreground', 'primary-tint'],
  ['foreground', 'secondary'],
  ['destructive-foreground', 'danger'],
  // Android's snackbar: inverse colours.
  ['background', 'foreground'],
  // Errors, destructive actions and Android's chips.
  ['danger-strong', 'background'],
  ['danger-strong', 'card'],
  ['success-strong', 'background'],
  ['success-strong', 'card'],
  ['warning-strong', 'background'],
  ['warning-strong', 'card'],
  ['info-strong', 'background'],
  ['info-strong', 'card'],
];

/** The validation's name of a library colour token. */
const VALIDATED_ROLE: Record<string, string> = {
  'primary-strong': 'primary-text',
  'primary-tint-foreground': 'primary-ink',
  danger: 'destructive',
  'danger-strong': 'destructive-strong',
  'success-strong': 'green-text',
  'warning-strong': 'amber-text',
  'info-strong': 'blue-text',
};

describe('platform looks and the theme validation', () => {
  it('draw text only on fills the validation checks', () => {
    const role = (token: string) => VALIDATED_ROLE[token] ?? token;
    const checked = new Set(
      CONTRAST_PAIRS.flatMap(([text, fill]) => [
        `${text} on ${fill}`,
        // Contrast is symmetric: inverse colours read the same.
        `${fill} on ${text}`,
      ]),
    );
    const unchecked = PLATFORM_TEXT_PAIRS.map(
      ([text, fill]) => `${role(text)} on ${role(fill)}`,
    ).filter((pair) => !checked.has(pair));
    expect(unchecked).toEqual([]);
  });
});
