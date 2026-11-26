/**
 * The web draws `desk` exactly as it did before themes became data.
 * `desk-golden.json` holds the Mantine theme and CSS variables the platform
 * emitted then, for every accent.
 */
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
} from '@mantine/core';
import { describe, expect, it } from 'vitest';
import tokens from '../../../packages/hatch-design-tokens/tokens.json';
import golden from '../../../packages/hatch-design-tokens/test/desk-golden.json';
import {
  THEME_PRESETS,
  resolvePreset,
  resolveTheme,
} from '../../../packages/hatch-design-tokens/src';
import { cssVariablesResolver } from './cssVariableResolver';
import { deskThemeFor } from './theme';

/** Opaque `rgba(…, 1)` and `#rrggbb` spell the same colour. */
function canonical(value: unknown): unknown {
  if (typeof value === 'string') {
    const rgba = /^rgba\((\d+), (\d+), (\d+), 1\)$/.exec(value);
    if (rgba)
      return `#${rgba
        .slice(1, 4)
        .map((channel) => Number(channel).toString(16).padStart(2, '0'))
        .join('')}`.toUpperCase();
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function emitted(accent: string) {
  const theme = mergeMantineTheme(
    DEFAULT_THEME,
    deskThemeFor(
      resolvePreset(
        'desk',
        tokens.accents[accent as keyof typeof tokens.accents],
      ),
    ),
  );
  const base = defaultCssVariablesResolver(theme);
  const ours = cssVariablesResolver(theme);
  return { theme, base, ours };
}

describe('the web desk theme', () => {
  it.each(Object.keys(tokens.accents))(
    'matches the pre-theme output with %s',
    (accent) => {
      const before = (golden as Record<string, (typeof golden)['indigo']>)[
        accent
      ].web;
      const { theme, base, ours } = emitted(accent);
      const variables = { ...base.variables, ...ours.variables };
      // Variables added since are new names; every old one keeps its value.
      for (const [name, value] of Object.entries(before.variables))
        expect({ name, value: canonical(variables[name as never]) }).toEqual({
          name,
          value: canonical(value),
        });
      expect(canonical({ ...base.light, ...ours.light })).toEqual(
        canonical(before.light),
      );
      expect(
        canonical({
          white: theme.white,
          black: theme.black,
          colors: theme.colors,
          fontFamily: theme.fontFamily,
          fontFamilyMonospace: theme.fontFamilyMonospace,
          radius: theme.radius,
          shadows: theme.shadows,
        }),
      ).toEqual(canonical(before.theme));
    },
  );

  it('switches the scheme roles to the dark theme', () => {
    const theme = mergeMantineTheme(
      DEFAULT_THEME,
      deskThemeFor(resolvePreset('desk-dark')),
    );
    const ours = cssVariablesResolver(theme);
    expect(ours.dark['--mantine-color-body']).toBe(tokens.dark.background);
    expect(ours.dark).toEqual(ours.light);
    expect(theme.colors.dark[7]).toBe(tokens.dark.background);
    expect(theme.white).toBe('#FFFFFF');
  });

  it('labels a filled primary with the validated foreground, also on a pale primary', () => {
    const pale = resolveTheme(
      {
        ...THEME_PRESETS['desk-dark'].document,
        colors: {
          ...THEME_PRESETS['desk-dark'].document.colors,
          primary: '#818181',
        },
      },
      { name: 'Pale', source: 'custom' },
    );
    const theme = mergeMantineTheme(DEFAULT_THEME, deskThemeFor(pale));
    const roles = cssVariablesResolver(theme).dark;
    // A dark label, not Mantine's white guess, and a hover that steps away
    // from it (lighter).
    expect(pale.colors['primary-foreground']).toBe(tokens.dark.background);
    expect(roles['--mantine-primary-color-contrast']).toBe(
      tokens.dark.background,
    );
    expect(roles['--mantine-color-primary-filled-hover']).toBe(
      'var(--mantine-color-primary-7)',
    );
    expect(
      theme.variantColorResolver({
        color: 'primary',
        theme,
        variant: 'filled',
      }).color,
    ).toBe('var(--mantine-primary-color-contrast)');
    expect(
      theme.variantColorResolver({ color: 'red', theme, variant: 'filled' })
        .color,
    ).toBe('var(--mantine-color-white)');
  });
});
