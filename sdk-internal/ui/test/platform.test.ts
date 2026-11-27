/**
 * Which platform's look an App takes, and the font it then draws with. Pure
 * rules of `src/core/platform.ts`; `fixtures/platform` checks them in NSH.
 */
import { describe, expect, it } from 'vitest';
import {
  contrast,
  mix,
  resolvePreset,
} from '../../../packages/hatch-design-tokens/src/index.ts';
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
    for (const platform of ['ios', 'android', 'macos', 'windows'])
      expect(resolvePlatform('web', { platform })).toBe(platform);
  });

  it('is the web in a browser and for anything else the shell passes', () => {
    for (const platform of [undefined, '', 'linux', 'IOS', 7, null])
      expect(resolvePlatform('web', { platform })).toBe('web');
  });

  it('has a look of its own on iOS, Android, macOS and Windows; Linux takes the web look', () => {
    expect(
      ['ios', 'android', 'macos', 'windows', 'linux', 'web'].map(lookOf),
    ).toEqual(['ios', 'android', 'macos', 'windows', 'web', 'web']);
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
  it('is the platform font for every bundled sans choice on the platform looks', () => {
    for (const face of BUNDLED_FONTS.sans) {
      expect(sans(platformTheme(withSans(face), 'ios'))).toBe('system-ui');
      expect(sans(platformTheme(withSans(face), 'android'))).toBe('Roboto');
      expect(sans(platformTheme(withSans(face), 'macos'))).toBe('system-ui');
      expect(sans(platformTheme(withSans(face), 'windows'))).toBe(
        'Segoe UI Variable',
      );
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
    for (const look of ['ios', 'android', 'macos', 'windows'] as const)
      expect(platformTheme(theme, look).cssVars.theme['font-sans']).toBe(
        theme.cssVars.theme['font-sans'],
      );
  });
});

describe('the platform theme', () => {
  it("adds the platform's sheet radius and keeps every other token", () => {
    const theme = buildAppTheme();
    const window = theme.cssVars.theme['radius-window'];
    for (const [look, radius] of [
      ['ios', '24px'],
      ['android', '28px'],
      // Desktops have no bottom sheet: theirs stays the window radius.
      ['macos', window],
      ['windows', window],
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
  ['danger-tint-foreground', 'danger-tint'],
  // iOS's gray buttons: the ground on a card, a card on the ground.
  ['foreground', 'background'],
  ['foreground', 'card'],
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
  // Cards' working tone.
  ['working-strong', 'background'],
  ['working-strong', 'card'],
];

/** The validation's name of a library colour token. */
const VALIDATED_ROLE: Record<string, string> = {
  'primary-strong': 'primary-text',
  'primary-tint-foreground': 'primary-ink',
  'danger-tint-foreground': 'destructive-ink',
  'danger-tint': 'destructive-tint',
  danger: 'destructive',
  'danger-strong': 'destructive-strong',
  'success-strong': 'green-text',
  'warning-strong': 'amber-text',
  'info-strong': 'blue-text',
  'working-strong': 'orange-text',
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

/** `rgba(r, g, b, a)` composited over an opaque `backdrop`. */
function over(fill: string, backdrop: string): string {
  const match = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(fill);
  if (!match) return fill;
  const [, r, g, b, a] = match;
  const hex = `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  return mix(backdrop, hex, Number(a));
}

/** Every preset in every accent, as an App's theme. */
const themes = (['desk', 'desk-dark'] as const).flatMap((preset) =>
  Object.entries(tokens.accents).map(([accent, color]) => ({
    name: `${preset}/${accent}`,
    t: buildAppTheme({ theme: resolvePreset(preset, color) }).cssVars.light,
  })),
);

describe('platform looks on the translucent and popup fills', () => {
  it('draw popups (alerts, menus, toasts) on the card colour', () => {
    for (const { name, t } of themes)
      expect([name, t.popover]).toEqual([name, t.card]);
  });

  it('keep text at 4.5:1 on the iOS tab bar and segmented control', () => {
    const failing = themes.flatMap(({ name, t }) =>
      [t.background, t.card].flatMap((backdrop) => {
        const bar = over(t['surface-dock'], backdrop);
        const segment = over(t['surface-pressed'], backdrop);
        return [
          ['primary-strong on the tab bar', t['primary-strong'], bar],
          ['muted-foreground on the tab bar', t['muted-foreground'], bar],
          ['foreground on a segment', t.foreground, segment],
        ]
          .filter(([, text, fill]) => contrast(text, fill) < 4.5)
          .map(([pair]) => `${name}: ${pair} over ${backdrop}`);
      }),
    );
    expect(failing).toEqual([]);
  });
});

describe('desktop looks on their selections and materials', () => {
  it('keep text at 4.5:1 on the fills the desktops add', () => {
    const failing = themes.flatMap(({ name, t }) => {
      const checks: [string, string, string][] = [
        // macOS's selected sidebar row: a pressed fill over the ground.
        [
          'foreground on the selected macOS sidebar row',
          t.foreground,
          over(t['surface-pressed'], t.background),
        ],
        // macOS's segmented control: labels on the sunken track.
        [
          'foreground on the macOS segmented track',
          t.foreground,
          t['surface-sunken'],
        ],
      ];
      // Fluent's selected navigation and list rows: a hover fill over the
      // ground (the pane) or a card (a list).
      for (const backdrop of [t.background, t.card])
        checks.push([
          `foreground on a selected Windows row over ${backdrop}`,
          t.foreground,
          over(t['surface-hover'], backdrop),
        ]);
      // macOS's menus and toasts: translucent material over a page, the
      // ground or a card.
      for (const backdrop of [t['surface-window'], t.background, t.card]) {
        const material = over(t['surface-dock'], backdrop);
        for (const token of [
          'foreground',
          'muted-foreground',
          'danger-strong',
          'primary-strong',
        ])
          checks.push([
            `${token} on macOS material over ${backdrop}`,
            t[token],
            material,
          ]);
      }
      return checks
        .filter(([, text, fill]) => contrast(text, fill) < 4.5)
        .map(([pair]) => `${name}: ${pair}`);
    });
    expect(failing).toEqual([]);
  });
});
