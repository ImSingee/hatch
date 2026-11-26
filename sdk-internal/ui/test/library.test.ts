/**
 * Durable rules of `@hatch/ui` that hold without NSH installed: generated
 * files in sync, the catalogue's prop rules, token-only styling, and a theme
 * that matches the platform and reads well in every accent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import tokens from '../../../packages/hatch-design-tokens/tokens.json' with { type: 'json' };
import { colorRamp as platformColorRamp } from '../../../src/ui/theme/theme';
import {
  CATEGORIES,
  FORBIDDEN_PROPS,
  catalogueEntries,
} from '../scripts/catalogue.ts';
import { UI_ROOT, generatedFiles } from '../scripts/outputs.ts';
import { typeScale } from '../theme/tailwind.ts';
import { ACCENT_NAMES, buildAppTheme, colorRamp } from '../theme/build.ts';

const LIB = path.join(UI_ROOT, 'src');

function libraryFiles(directory = LIB): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return libraryFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Source without comments, so prose may name colours and sizes. */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Files allowed to hold literal geometry or generated data. */
const EXEMPT = new Set([
  'core/metrics.ts',
  'core/tokens.gen.ts',
  'icons/icons.gen.ts',
]);

const hand = () =>
  libraryFiles().filter((file) => !EXEMPT.has(path.relative(LIB, file)));

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Mantine's ramp holds `rgba()` strings, and the token itself as hex. */
function rgbaToHex(rgba: string): string {
  if (rgba.startsWith('#')) return rgba.toUpperCase();
  const [r, g, b] = (rgba.match(/\d+/g) ?? []).map(Number);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function luminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('generated files', () => {
  it('match the tokens, the icon list and the component types', () => {
    // Run node_modules/.bin/tsx sdk-internal/ui/scripts/generate.ts to update.
    const stale = generatedFiles()
      .filter((file) => fs.readFileSync(file.path, 'utf8') !== file.content)
      .map((file) => path.relative(UI_ROOT, file.path));
    expect(stale).toEqual([]);
  });
});

describe('catalogue', () => {
  it('lists exactly the exported components, each in a category', () => {
    const entries = catalogueEntries();
    const listed = CATEGORIES.flatMap((category) => category.names);
    expect([...entries.keys()].sort()).toEqual([...listed].sort());
  });

  it('has no component that takes class or style', () => {
    const offenders = [...catalogueEntries().values()].flatMap((entry) =>
      entry.kind === 'component'
        ? entry.props
            .filter((prop) =>
              (FORBIDDEN_PROPS as readonly string[]).includes(prop.name),
            )
            .map((prop) => `${entry.name}.${prop.name}`)
        : [],
    );
    expect(offenders).toEqual([]);
  });
});

describe('styling uses tokens only', () => {
  const colors = new Set(Object.keys(buildAppTheme().cssVars.light));

  /** `file: match` for every match of `pattern` in the hand-written files. */
  function findings(pattern: RegExp): string[] {
    return hand().flatMap((file) =>
      [...code(file).matchAll(pattern)].map(
        (match) => `${path.relative(LIB, file)}: ${match[0]}`,
      ),
    );
  }

  it('writes no colour literal in the library', () => {
    expect(findings(/#[0-9a-fA-F]{3,8}\b/g)).toEqual([]);
    expect(findings(/\b(?:rgba?|hsla?|oklch)\(/g)).toEqual([]);
  });

  it('writes no literal length in a class or a style', () => {
    // Arbitrary values may name environment insets and percentages only.
    expect(findings(/\[[^\]\s]*\d(?:px|rem|em|pt)\b[^\]\s]*\]/g)).toEqual([]);
    expect(findings(/style=\{\{[^}]*:\s*\d[^}]*\}\}/g)).toEqual([]);
  });

  it('names a theme token in every colour class', () => {
    const typeSizes = new Set(Object.keys(typeScale));
    const nonColour: Record<string, RegExp> = {
      text: /^(start|center|end|left|right|justify|pretty|balance|wrap|nowrap|ellipsis|clip)$/,
      border: /^(t|b|l|r|x|y|\d+|none|solid|dashed|dotted|hidden)(-\d+)?$/,
      outline: /^(\d+|none|solid|dashed|offset-\d+)$/,
      ring: /^(\d+|inset|offset-\d+)$/,
      bg: /^(linear|radial|conic)/,
    };
    const utility =
      /(?:^|\s|["'`:])((?:[a-z-]+:)*)(bg|text|border(?:-[trblxy])?|outline|ring|fill|stroke|from|via|to|placeholder|caret|decoration)-([a-z][a-z0-9-]*?)(?:\/\d+)?(?=$|[\s"'`])/g;
    const unknown = hand().flatMap((file) =>
      [...code(file).matchAll(utility)].flatMap((match) => {
        const prefix = match[2].startsWith('border') ? 'border' : match[2];
        const name = match[3];
        if (prefix === 'text' && typeSizes.has(name)) return [];
        if (nonColour[prefix]?.test(name)) return [];
        if (colors.has(name)) return [];
        return [`${path.relative(LIB, file)}: ${match[0].trim()}`];
      }),
    );
    expect(unknown).toEqual([]);
  });

  it('has a monogram fill for every tile colour', () => {
    const display = fs.readFileSync(
      path.join(LIB, 'display/Display.tsx'),
      'utf8',
    );
    const fills = [...display.matchAll(/'bg-tile-(\d+)'/g)].map((m) =>
      Number(m[1]),
    );
    expect(fills).toEqual(tokens.tiles.map((_, index) => index));
  });
});

describe('theme', () => {
  it('derives the accent ramp as the platform does', () => {
    for (const accent of ACCENT_NAMES) {
      const base = tokens.accents[accent];
      expect(colorRamp(base)).toEqual(platformColorRamp(base).map(rgbaToHex));
    }
  });

  it('gives every accent the same tokens', () => {
    const keys = (accent: (typeof ACCENT_NAMES)[number]) =>
      Object.keys(buildAppTheme({ accent }).cssVars.light).sort();
    for (const accent of ACCENT_NAMES)
      expect(keys(accent)).toEqual(keys('indigo'));
  });

  it('keeps text at 4.5:1 or better in every accent', () => {
    for (const accent of ACCENT_NAMES) {
      const t = buildAppTheme({ accent }).cssVars.light;
      const pairs: [string, string][] = [
        ['primary-foreground', 'primary'],
        ['primary-foreground', 'primary-strong'],
        ['primary-tint-foreground', 'primary-tint'],
        ['primary-tint-foreground', 'primary-tint-hover'],
        ['primary-strong', 'card'],
        ['primary-strong', 'surface-window'],
        ['foreground', 'surface-window'],
        ['muted-foreground', 'card'],
        ['muted-foreground', 'surface-window'],
        ['destructive-foreground', 'danger'],
        ...(['danger', 'warning', 'success', 'info'] as const).flatMap(
          (tone): [string, string][] => [
            [`${tone}-tint-foreground`, `${tone}-tint`],
            [`${tone}-strong`, 'card'],
          ],
        ),
        ...tokens.tiles.map((_, index): [string, string] => [
          'tile-foreground',
          `tile-${index}`,
        ]),
      ];
      const failing = pairs
        .filter(([text, fill]) => contrast(t[text], t[fill]) < 4.5)
        .map(([text, fill]) => `${accent}: ${text} on ${fill}`);
      expect(failing).toEqual([]);
    }
  });
});
