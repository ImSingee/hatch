import type { CSSVariablesResolver } from '@mantine/core';
import tokens from '../../../packages/hatch-design-tokens/tokens.json';
import {
  FILL_PRESSED_SHADE,
  type ThemeAppearance,
} from '../../../packages/hatch-design-tokens/src';
import { HUE_COLOR_NAMES, resolvedThemeOf } from './theme';

/**
 * How each chromatic palette fills Mantine's variants. Mantine's own defaults
 * put shade-6 text on a 10% tint, which fails AA for small text; Desk uses a
 * solid light tint with shade-8 text, and shade 7 wherever a hue is used as a
 * text or outline colour.
 */
function hueRoles(
  name: string,
  appearance: ThemeAppearance,
): Record<string, string> {
  const shade = (step: number) => `var(--mantine-color-${name}-${step})`;
  return {
    // A dark ramp's shade 7 is lighter (it is the text shade there), so a
    // hovered fill steps towards the surface instead.
    ...(appearance === 'dark'
      ? {
          [`--mantine-color-${name}-filled-hover`]: shade(
            FILL_PRESSED_SHADE.dark,
          ),
        }
      : {}),
    [`--mantine-color-${name}-text`]: shade(7),
    [`--mantine-color-${name}-light`]: shade(1),
    [`--mantine-color-${name}-light-hover`]: shade(2),
    [`--mantine-color-${name}-light-color`]: shade(8),
    [`--mantine-color-${name}-outline`]: shade(7),
    [`--mantine-color-${name}-outline-hover`]: shade(0),
  };
}

/**
 * Every Desk variable and Mantine colour role from the resolved theme the
 * Mantine theme was built from. The roles are the same for Mantine's light
 * and dark colour schemes; the root follows the theme's appearance.
 */
export const cssVariablesResolver: CSSVariablesResolver = (mantineTheme) => {
  const theme = resolvedThemeOf(mantineTheme);
  const c = theme.colors;
  const roles: Record<string, string> = {
    '--mantine-color-body': c.background,
    '--mantine-color-text': c.foreground,
    '--mantine-color-dimmed': c['muted-foreground'],
    '--mantine-color-placeholder': c['muted-foreground'],
    '--mantine-color-anchor': 'var(--mantine-color-primary-7)',
    '--mantine-color-error': 'var(--mantine-color-red-7)',

    '--mantine-color-default': c.card,
    '--mantine-color-default-color': c.foreground,
    '--mantine-color-default-hover': c['surface-hover'],
    '--mantine-color-default-border': c.hairline,

    '--mantine-color-disabled': c['surface-hover'],
    '--mantine-color-disabled-color': 'var(--mantine-color-gray-5)',
    '--mantine-color-disabled-border': c.hairline,

    // Neutral ink variants: a wash of ink that reads on the ground and on
    // cards alike.
    '--mantine-color-gray-text': 'var(--mantine-color-gray-6)',
    '--mantine-color-gray-light': c['surface-hover'],
    '--mantine-color-gray-light-hover': c['surface-pressed'],
    '--mantine-color-gray-light-color': 'var(--mantine-color-gray-7)',
    '--mantine-color-gray-outline': 'var(--mantine-color-gray-6)',
    '--mantine-color-gray-outline-hover': c['surface-hover'],

    ...Object.assign(
      {},
      ...HUE_COLOR_NAMES.map((name) => hueRoles(name, theme.appearance)),
    ),
  };
  return {
    variables: {
      '--surface-panel': c['surface-panel'],
      '--surface-raised': c.card,
      '--surface-muted': c.muted,
      '--surface-sunken': c['surface-sunken'],
      '--surface-hover': c['surface-hover'],
      '--surface-pressed': c['surface-pressed'],
      '--surface-scrim': c['surface-scrim'],
      '--border-hairline': c.hairline,
      '--border-input': c.input,
      '--border-glass': c['glass-edge'],
      '--focus-ring': c.ring,
      '--surface-dock': c['surface-dock'],
      '--surface-widget': c['surface-widget'],
      '--surface-window': c['surface-window'],
      '--surface-bubble': c['surface-bubble'],
      '--border-composer': c['composer-border'],
      // Text and glyphs on a filled tile or chip.
      '--on-fill': c['on-fill'],
      // The accent shape on the ground is a flat tint of the current accent.
      '--ground-shape-accent': `color-mix(in srgb, var(--mantine-color-primary-6) ${tokens.ground.accentTint}%, ${c.card})`,
      '--ground-shape-warm': c['ground-warm'],
      '--ground-shape-fresh': c['ground-fresh'],
      '--radius-window': `${theme.radius.window}px`,
      '--radius-dock': `${theme.radius.dock}px`,
      '--radius-widget': `${theme.radius.widget}px`,
      '--radius-tile': `${theme.radius.tile}px`,
      '--size-dock-tile': `${tokens.sizes.dockTile}px`,
      '--size-widget-icon': `${tokens.sizes.widgetIcon}px`,
      '--tile-light': tokens.tileLight,
      '--shadow-card': theme.shadows.card,
      '--shadow-dock': theme.shadows.dock,
      '--shadow-window': theme.shadows.window,
      '--font-weight-body': String(tokens.fontWeights.body),
      '--font-weight-strong': String(tokens.fontWeights.strong),
      '--font-weight-label': String(tokens.fontWeights.label),
      '--font-weight-heading': String(tokens.fontWeights.heading),
      '--ease-out-quart': tokens.motion.easing,
      '--transition-fast': `${tokens.motion.fast}ms ${tokens.motion.easing}`,
      '--transition-base': `${tokens.motion.base}ms ${tokens.motion.easing}`,
      '--transition-slow': `${tokens.motion.slow}ms ${tokens.motion.easing}`,
    },
    light: roles,
    dark: roles,
  };
};
