/**
 * The Tailwind extension of a native-runtime App (`nsh.json` `"tailwind"`):
 * the Desk type scale, weights and shadows from DESIGN.md and the design
 * tokens. Colours, radii and fonts are theme tokens instead (`theme.json`),
 * because the host can change them while the App runs; these values are
 * compiled into the bundle.
 */
import tokens from '../../../packages/hatch-design-tokens/tokens.json' with { type: 'json' };

/** `[size, lineHeight / size]`, as NSH's `fontSize` entries take them. */
function type(size: number, lineHeight: number): [number, number] {
  return [size, Number((lineHeight / size).toFixed(4))];
}

/** DESIGN.md "Typography" and the component sizes it specifies. */
export const typeScale = {
  display: type(30, 38),
  title: type(24, 32),
  section: type(20, 28),
  modal: type(18, 26),
  subsection: type(17, 24),
  'body-lg': type(16, 24),
  control: type(15, 22),
  body: type(14, 20),
  'control-sm': type(13, 18),
  caption: type(12, 18),
  eyebrow: type(11, 16),
} as const;

export type TailwindExtension = {
  fontSize: Record<string, [number, number]>;
  fontWeight: Record<string, number>;
  tracking: Record<string, number>;
  shadow: Record<string, string>;
};

export function buildTailwindExtension(): TailwindExtension {
  return {
    fontSize: { ...typeScale },
    fontWeight: { ...tokens.fontWeights },
    tracking: { heading: -0.01, eyebrow: 0.06 },
    shadow: { ...tokens.shadows },
  };
}
