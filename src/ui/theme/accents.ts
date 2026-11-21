/**
 * The accents an instance can choose from, read from the design tokens. Free
 * of UI imports so the server, the CLI and the theme share one list.
 */
import tokens from '../../../packages/hatch-design-tokens/tokens.json';

export type AccentName = keyof typeof tokens.accents;

export const ACCENT_NAMES = Object.keys(tokens.accents) as [
  AccentName,
  ...AccentName[],
];

export const DEFAULT_ACCENT = tokens.defaultAccent as AccentName;

/** Base colour (`#RRGGBB`) of each accent; the filled shade of its ramp. */
export const ACCENT_COLORS: Readonly<Record<AccentName, string>> =
  tokens.accents;

export function isAccentName(value: unknown): value is AccentName {
  return typeof value === 'string' && Object.hasOwn(tokens.accents, value);
}
