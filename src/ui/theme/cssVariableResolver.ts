import type { CSSVariablesResolver } from '@mantine/core';
import tokens from '../../../packages/hatch-design-tokens/tokens.json';
import { HUE_COLOR_NAMES } from './theme';

/**
 * How each chromatic palette fills Mantine's variants. Mantine's own defaults
 * put shade-6 text on a 10% tint, which fails AA for small text; Desk uses a
 * solid light tint with shade-8 text, and shade 7 wherever a hue is used as a
 * text or outline colour.
 */
function hueRoles(name: string): Record<string, string> {
  const shade = (step: number) => `var(--mantine-color-${name}-${step})`;
  return {
    [`--mantine-color-${name}-text`]: shade(7),
    [`--mantine-color-${name}-light`]: shade(1),
    [`--mantine-color-${name}-light-hover`]: shade(2),
    [`--mantine-color-${name}-light-color`]: shade(8),
    [`--mantine-color-${name}-outline`]: shade(7),
    [`--mantine-color-${name}-outline-hover`]: shade(0),
  };
}

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--surface-panel': tokens.surfaces.panel,
    '--surface-raised': tokens.light.card,
    '--surface-muted': tokens.light.muted,
    '--surface-sunken': tokens.surfaces.sunken,
    '--surface-hover': tokens.surfaces.hover,
    '--surface-pressed': tokens.surfaces.pressed,
    '--surface-scrim': tokens.surfaces.scrim,
    '--border-hairline': tokens.surfaces.hairline,
    '--border-input': tokens.light.input,
    '--focus-ring': tokens.light.ring,
    '--surface-dock': tokens.surfaces.dock,
    '--surface-widget': tokens.surfaces.widget,
    '--surface-window': tokens.surfaces.window,
    '--surface-bubble': tokens.surfaces.bubble,
    '--border-composer': tokens.surfaces.composerBorder,
    // The accent shape on the ground is a flat tint of the current accent.
    '--ground-shape-accent': `color-mix(in srgb, var(--mantine-color-primary-6) ${tokens.ground.accentTint}%, ${tokens.light.card})`,
    '--ground-shape-warm': tokens.ground.warm,
    '--ground-shape-fresh': tokens.ground.fresh,
    '--radius-window': `${tokens.radius.window}px`,
    '--radius-dock': `${tokens.radius.dock}px`,
    '--radius-widget': `${tokens.radius.widget}px`,
    '--radius-tile': `${tokens.radius.tile}px`,
    '--size-dock-tile': `${tokens.sizes.dockTile}px`,
    '--size-widget-icon': `${tokens.sizes.widgetIcon}px`,
    '--tile-light': tokens.tileLight,
    '--shadow-card': tokens.shadows.card,
    '--shadow-dock': tokens.shadows.dock,
    '--shadow-window': tokens.shadows.window,
    '--font-weight-body': String(tokens.fontWeights.body),
    '--font-weight-strong': String(tokens.fontWeights.strong),
    '--font-weight-label': String(tokens.fontWeights.label),
    '--font-weight-heading': String(tokens.fontWeights.heading),
    '--ease-out-quart': tokens.motion.easing,
    '--transition-fast': `${tokens.motion.fast}ms ${tokens.motion.easing}`,
    '--transition-base': `${tokens.motion.base}ms ${tokens.motion.easing}`,
  },
  light: {
    '--mantine-color-body': tokens.light.background,
    '--mantine-color-text': tokens.light.foreground,
    '--mantine-color-dimmed': tokens.light['muted-foreground'],
    '--mantine-color-placeholder': tokens.light['muted-foreground'],
    '--mantine-color-anchor': 'var(--mantine-color-primary-7)',
    '--mantine-color-error': 'var(--mantine-color-red-7)',

    '--mantine-color-default': tokens.light.card,
    '--mantine-color-default-color': tokens.light.foreground,
    '--mantine-color-default-hover': tokens.surfaces.hover,
    '--mantine-color-default-border': tokens.surfaces.hairline,

    '--mantine-color-disabled': tokens.surfaces.hover,
    '--mantine-color-disabled-color': 'var(--mantine-color-gray-5)',
    '--mantine-color-disabled-border': tokens.surfaces.hairline,

    // Neutral ink variants: a wash of ink that reads on the ground and on
    // cards alike.
    '--mantine-color-gray-text': 'var(--mantine-color-gray-6)',
    '--mantine-color-gray-light': tokens.surfaces.hover,
    '--mantine-color-gray-light-hover': tokens.surfaces.pressed,
    '--mantine-color-gray-light-color': 'var(--mantine-color-gray-7)',
    '--mantine-color-gray-outline': 'var(--mantine-color-gray-6)',
    '--mantine-color-gray-outline-hover': tokens.surfaces.hover,

    ...Object.assign({}, ...HUE_COLOR_NAMES.map(hueRoles)),
  },
  dark: {},
});
