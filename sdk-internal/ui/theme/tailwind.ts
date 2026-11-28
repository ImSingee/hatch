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

/**
 * The type the platform looks set (`src/core/platform.ts`): Apple's Dynamic
 * Type at its default size, Material 3's type scale, macOS's text styles
 * (13-point body) and Windows 11's Fluent type ramp (14-point body; `label`
 * is the 13-point label of the design boards' controls), which the design
 * boards follow. The web keeps `typeScale`.
 */
export const platformTypeScale = {
  'ios-large-title': type(34, 41),
  'ios-title-1': type(28, 34),
  'ios-title-2': type(22, 28),
  'ios-title-3': type(20, 25),
  'ios-body': type(17, 22),
  'ios-callout': type(16, 21),
  'ios-subhead': type(15, 20),
  'ios-footnote': type(13, 18),
  'ios-caption': type(12, 16),
  'ios-caption-2': type(11, 13),
  'm3-headline-lg': type(32, 40),
  'm3-headline-md': type(28, 36),
  'm3-headline-sm': type(24, 32),
  'm3-title-lg': type(22, 28),
  'm3-title-md': type(16, 24),
  'm3-title-sm': type(14, 20),
  'm3-body-lg': type(16, 24),
  'm3-body-md': type(14, 20),
  'm3-body-sm': type(12, 16),
  'm3-label-lg': type(14, 20),
  'm3-label-md': type(12, 16),
  'm3-label-sm': type(11, 16),
  'mac-large-title': type(26, 32),
  'mac-title-1': type(22, 26),
  'mac-title-2': type(17, 22),
  'mac-title-3': type(15, 20),
  'mac-body': type(13, 18),
  'mac-callout': type(12, 16),
  'mac-subhead': type(11, 14),
  'win-title-lg': type(40, 52),
  'win-title': type(28, 36),
  'win-subtitle': type(20, 28),
  'win-body-lg': type(18, 24),
  'win-body': type(14, 20),
  'win-label': type(13, 18),
  'win-caption': type(12, 16),
} as const;

/** The weights of the system faces: SF Pro, Roboto and Segoe UI read
 * heavier than Nunito at the same number, so the platform looks name these
 * instead of the Desk's `fontWeights`. */
export const platformWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export type TailwindExtension = {
  fontSize: Record<string, [number, number]>;
  fontWeight: Record<string, number>;
  tracking: Record<string, number>;
  shadow: Record<string, string>;
};

export function buildTailwindExtension(): TailwindExtension {
  return {
    fontSize: { ...typeScale, ...platformTypeScale },
    fontWeight: { ...tokens.fontWeights, ...platformWeights },
    tracking: { heading: -0.01, eyebrow: 0.06 },
    shadow: { ...tokens.shadows },
  };
}
