/**
 * Checks a theme document before it is saved: its shape, its colours, its
 * fonts and the contrast of every text colour on the surfaces it is read on.
 */
import { contrast, normalizeColor, parseColor } from './color';
import {
  BASE_RADIUS,
  BUNDLED_FONTS,
  MAX_RADIUS,
  TEXT_SHADE,
  THEME_APPEARANCES,
  THEME_COLOR_KEYS,
  resolveTheme,
  type ResolvedColorKey,
  type ResolvedTheme,
  type ThemeDocument,
} from './theme';

/** WCAG AA for body text. */
export const MIN_TEXT_CONTRAST = 4.5;
const MAX_NAME_LENGTH = 48;

export type ThemeProblemCode =
  | 'invalid_document'
  | 'unknown_key'
  | 'missing_key'
  | 'invalid_color'
  | 'invalid_value'
  | 'unknown_font'
  | 'low_contrast';

export type ThemeProblem = {
  code: ThemeProblemCode;
  /** Dotted path of the key at fault (`colors.primary`), or empty. */
  path: string;
  message: string;
  /** For `low_contrast`: the pair that failed. */
  pair?: {
    foreground: string;
    background: string;
    ratio: number;
    required: number;
  };
};

export type ThemeValidation =
  | { ok: true; document: ThemeDocument }
  | { ok: false; problems: ThemeProblem[] };

/** The `primary` ramp's text shade, as the pairs name it. */
const PRIMARY_TEXT = 'primary-text';

type PairRole = ResolvedColorKey | typeof PRIMARY_TEXT;

/**
 * Every text colour on every surface it is drawn on. The first four are the
 * pairs the theme design names; the rest guard text the derivation produces.
 */
export const CONTRAST_PAIRS: readonly (readonly [PairRole, PairRole])[] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['muted-foreground', 'background'],
  ['primary-foreground', 'primary'],
  ['foreground', 'secondary'],
  ['foreground', 'muted'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['destructive-foreground', 'destructive'],
  ['destructive-text', 'background'],
  ['destructive-text', 'card'],
  ['destructive-text', 'muted'],
  [PRIMARY_TEXT, 'background'],
  [PRIMARY_TEXT, 'card'],
];

function roleColor(theme: ResolvedTheme, role: PairRole): string {
  return role === PRIMARY_TEXT
    ? theme.ramps.primary[TEXT_SHADE]
    : theme.colors[role];
}

/** Rounded down, so a reported ratio never looks like it passed. */
function floorRatio(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}

/** Each pair of a resolved theme that reads below 4.5:1. */
export function contrastProblems(theme: ResolvedTheme): ThemeProblem[] {
  const problems: ThemeProblem[] = [];
  for (const [text, surface] of CONTRAST_PAIRS) {
    const ratio = contrast(roleColor(theme, text), roleColor(theme, surface));
    if (ratio >= MIN_TEXT_CONTRAST) continue;
    const shown = floorRatio(ratio);
    problems.push({
      code: 'low_contrast',
      path: '',
      message: `${text} on ${surface} has a contrast of ${shown}:1; it needs at least ${MIN_TEXT_CONTRAST}:1.`,
      pair: {
        foreground: text,
        background: surface,
        ratio: shown,
        required: MIN_TEXT_CONTRAST,
      },
    });
  }
  return problems;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): ThemeProblem[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      code: 'unknown_key' as const,
      path: `${prefix}${key}`,
      message: `${prefix}${key} is not a theme key. Use ${allowed.join(', ')}.`,
    }));
}

const DOCUMENT_KEYS = ['name', 'appearance', 'colors', 'radius', 'fonts'];

/**
 * Read a theme document. Shape problems are reported all together; contrast
 * is checked only on a well-formed document, with `accent` (a colour that
 * replaces `primary`) when given.
 */
export function validateThemeDocument(
  input: unknown,
  options: { accent?: string | null } = {},
): ThemeValidation {
  if (!isRecord(input))
    return {
      ok: false,
      problems: [
        {
          code: 'invalid_document',
          path: '',
          message: 'A theme is a JSON object.',
        },
      ],
    };
  const problems = unknownKeys(input, DOCUMENT_KEYS, '');

  let name: string | undefined;
  if (input.name !== undefined) {
    if (
      typeof input.name !== 'string' ||
      !input.name.trim() ||
      input.name.length > MAX_NAME_LENGTH
    )
      problems.push({
        code: 'invalid_value',
        path: 'name',
        message: `name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`,
      });
    else name = input.name.trim();
  }

  const appearance = input.appearance;
  if (appearance === undefined)
    problems.push({
      code: 'missing_key',
      path: 'appearance',
      message: 'appearance is required: light or dark.',
    });
  else if (!(THEME_APPEARANCES as readonly unknown[]).includes(appearance))
    problems.push({
      code: 'invalid_value',
      path: 'appearance',
      message: 'appearance must be light or dark.',
    });

  const colors: Partial<Record<(typeof THEME_COLOR_KEYS)[number], string>> = {};
  if (input.colors === undefined)
    problems.push({
      code: 'missing_key',
      path: 'colors',
      message: `colors is required, with ${THEME_COLOR_KEYS.join(', ')}.`,
    });
  else if (!isRecord(input.colors))
    problems.push({
      code: 'invalid_value',
      path: 'colors',
      message: 'colors must be an object.',
    });
  else {
    problems.push(...unknownKeys(input.colors, THEME_COLOR_KEYS, 'colors.'));
    for (const key of THEME_COLOR_KEYS) {
      const value = input.colors[key];
      if (value === undefined)
        problems.push({
          code: 'missing_key',
          path: `colors.${key}`,
          message: `colors.${key} is required.`,
        });
      else if (typeof value !== 'string' || !parseColor(value))
        problems.push({
          code: 'invalid_color',
          path: `colors.${key}`,
          message: `colors.${key} is not an opaque colour; use #RRGGBB, #RGB or rgb(r g b).`,
        });
      else colors[key] = normalizeColor(value);
    }
  }

  let radius = BASE_RADIUS;
  if (input.radius !== undefined) {
    if (
      typeof input.radius !== 'number' ||
      !Number.isFinite(input.radius) ||
      input.radius < 0 ||
      input.radius > MAX_RADIUS
    )
      problems.push({
        code: 'invalid_value',
        path: 'radius',
        message: `radius must be a number of px from 0 to ${MAX_RADIUS}.`,
      });
    else radius = input.radius;
  }

  const fonts = { sans: BUNDLED_FONTS.sans[0], mono: BUNDLED_FONTS.mono[0] };
  if (input.fonts !== undefined) {
    if (!isRecord(input.fonts))
      problems.push({
        code: 'invalid_value',
        path: 'fonts',
        message: 'fonts must be an object with sans and mono.',
      });
    else {
      problems.push(...unknownKeys(input.fonts, ['sans', 'mono'], 'fonts.'));
      for (const role of ['sans', 'mono'] as const) {
        const value = input.fonts[role];
        if (value === undefined) continue;
        const bundled: readonly string[] = BUNDLED_FONTS[role];
        if (typeof value !== 'string' || !bundled.includes(value))
          problems.push({
            code: 'unknown_font',
            path: `fonts.${role}`,
            message: `fonts.${role} must be one of the bundled fonts: ${bundled.join(', ')}.`,
          });
        else fonts[role] = value;
      }
    }
  }

  if (problems.length) return { ok: false, problems };
  const document: ThemeDocument = {
    ...(name === undefined ? {} : { name }),
    appearance: appearance as ThemeDocument['appearance'],
    colors: colors as ThemeDocument['colors'],
    radius,
    fonts,
  };
  const resolved = (accent?: string | null) =>
    resolveTheme(document, {
      name: name ?? 'Custom',
      source: 'custom',
      accent,
    });
  // The document's own primary shows whenever no accent is chosen; the accent
  // shows while one is.
  const contrastIssues = contrastProblems(resolved());
  if (options.accent)
    for (const problem of contrastProblems(resolved(options.accent)))
      if (
        problem.pair &&
        [problem.pair.foreground, problem.pair.background].some((role) =>
          role.startsWith('primary'),
        )
      )
        contrastIssues.push({
          ...problem,
          message: `With the accent: ${problem.message}`,
        });
  if (contrastIssues.length) return { ok: false, problems: contrastIssues };
  return { ok: true, document };
}
