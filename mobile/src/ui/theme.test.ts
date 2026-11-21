import { describe, expect, it } from 'vitest';
import { accentNames, accentOf, palette as c, status, tiles } from './theme';

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(a: string, b: string) {
  const light = Math.max(luminance(a), luminance(b));
  const dark = Math.min(luminance(a), luminance(b));
  return (light + 0.05) / (dark + 0.05);
}

// The values come from the shared token file; this guards that whatever it
// holds stays readable in the pairings the native app actually draws.
describe('mobile readable color contract', () => {
  it.each([c.ground, c.card, c.muted, c.sunken])(
    'keeps body, secondary and error text readable on %s',
    (surface) => {
      for (const ink of [c.ink, c.inkSoft, status.danger.ink])
        expect(contrast(ink, surface)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(accentNames)('keeps the %s accent readable', (name) => {
    const accent = accentOf(name);
    // Filled buttons, the user's chat bubble, the selected conversation.
    expect(contrast(accent.onFill, accent.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(accent.onFill, accent.pressed)).toBeGreaterThanOrEqual(4.5);
    // Links and quiet buttons on every surface, and labels on the tint.
    for (const surface of [c.ground, c.card, c.muted, accent.tint])
      expect(contrast(accent.ink, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.entries(status))('keeps %s chips readable', (_name, hue) => {
    expect(contrast(hue.ink, hue.tint)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hue.ink, hue.tintStrong)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(tiles)('keeps the monogram readable on tile %s', (tile) => {
    expect(contrast(c.onFill, tile)).toBeGreaterThanOrEqual(4.5);
  });
});
