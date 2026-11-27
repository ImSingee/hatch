/**
 * Colour arithmetic for theme resolution. Pure TypeScript with no imports,
 * so the server, the CLI, the web client, the mobile app and the native UI
 * library build the same values from the same theme.
 */

export type Rgb = { r: number; g: number; b: number };

const HEX = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i;
const RGB_FN =
  /^rgb\(\s*(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})(?:\s*,\s*|\s+)(\d{1,3})\s*\)$/i;

/**
 * Read an opaque colour: `#RGB`, `#RRGGBB` or `rgb(r g b)` / `rgb(r, g, b)`.
 * Anything else (named colours, alpha, other colour spaces) is `null`: a
 * theme colour must be opaque so its contrast is defined.
 */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();
  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1]
      ? [...hex[1]].map((digit) => digit + digit).join('')
      : hex[2];
    const number = Number.parseInt(digits, 16);
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
  }
  const rgb = RGB_FN.exec(value);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map(Number);
    if ([r, g, b].every((channel) => channel <= 255)) return { r, g, b };
  }
  return null;
}

function rgbOf(color: string): Rgb {
  const parsed = parseColor(color);
  if (!parsed) throw new Error(`Not an opaque colour: ${color}`);
  return parsed;
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/** A colour as `#RRGGBB` in upper case. */
export function normalizeColor(color: string): string {
  return toHex(rgbOf(color));
}

/**
 * `amount` of the way from `from` to `to`, per channel, rounded. With white
 * as `to` it is Mantine's `lighten`; with black, Mantine's `darken`.
 */
export function mix(from: string, to: string, amount: number): string {
  const a = rgbOf(from);
  const b = rgbOf(to);
  const step = (x: number, y: number) => Math.round(x + (y - x) * amount);
  return toHex({ r: step(a.r, b.r), g: step(a.g, b.g), b: step(a.b, b.b) });
}

/** `color` at `opacity`, as `rgba(r, g, b, a)`. */
export function withAlpha(color: string, opacity: number): string {
  const { r, g, b } = rgbOf(color);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(color: string): number {
  const { r, g, b } = rgbOf(color);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG contrast ratio of two opaque colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Whichever of `candidates` reads best on `background`. */
export function mostLegible(
  background: string,
  candidates: readonly string[],
): string {
  return candidates.reduce((best, candidate) =>
    contrast(candidate, background) > contrast(best, background)
      ? candidate
      : best,
  );
}
