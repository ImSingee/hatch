/**
 * Server-only: the instance theme every client applies.
 *
 * The instance has one active theme, picked from a library: the presets
 * (`desk`, `desk-dark`) and the custom themes people and the Agent save on
 * the web or with the CLI (`themes` table). A dark theme is a theme like
 * any other; clients draw the active theme whatever their device prefers.
 * An optional accent replaces the active theme's primary.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import {
  DEFAULT_THEME,
  THEME_PRESETS,
  THEME_PRESET_NAMES,
  contrastProblems,
  isThemePresetName,
  normalizeColor,
  resolvePreset,
  resolveTheme,
  validateThemeDocument,
  type ResolvedTheme,
  type ThemeAppearance,
  type ThemeDocument,
  type ThemeProblem,
} from '../../packages/hatch-design-tokens/src';
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
  type AccentName,
} from '~/ui/theme/accents';
import { db, schema } from '~/db';
import { AppError } from '~server/errors';
import {
  DEFAULT_UI_THEME,
  getPlatformConfig,
  updatePlatformConfig,
  type UiThemeConfig,
} from '~server/platform-config';
import { publishPlatformEvent } from '~server/platform-events';
import { ThemeValidationError } from '~server/theme-errors';

/** One theme of the library. */
export type ThemeEntry = {
  /** A preset's name, or a custom theme's id. */
  id: string;
  name: string;
  source: 'preset' | 'custom';
  appearance: ThemeAppearance;
  /** The theme's own primary (`#RRGGBB`), shown while no accent is chosen. */
  primary: string;
  /** The theme document, as saved. */
  document: ThemeDocument;
  /**
   * False for a custom theme that no longer passes the current rules; it is
   * listed with its problems and cannot be activated until it is fixed.
   */
  valid: boolean;
  problems: ThemeProblem[];
};

export type ThemeState = {
  /** null: no accent, the active theme shows its own primary. */
  accent: AccentName | null;
  defaultAccent: AccentName;
  /** Every accent that can be chosen, in token order. */
  accents: { name: AccentName; color: string }[];
  /** Whether the web dock shows each tile's name under it; off by default. */
  dockLabels: boolean;
  /** The theme every client draws. */
  theme: ThemeEntry;
  /** Whether the chosen accent hides the active theme's own primary. */
  accentOverridesPrimary: boolean;
};

const MAX_CUSTOM_THEMES = 100;
const CUSTOM_NAME = 'Custom theme';

function presetEntry(name: (typeof THEME_PRESET_NAMES)[number]): ThemeEntry {
  const document = THEME_PRESETS[name].document;
  return {
    id: name,
    name: document.name ?? name,
    source: 'preset',
    appearance: document.appearance,
    primary: normalizeColor(document.colors.primary),
    document,
    valid: true,
    problems: [],
  };
}

type ThemeRow = typeof schema.themes.$inferSelect;

/** A stored custom theme, checked against the current rules. */
function customEntry(row: ThemeRow): ThemeEntry {
  const result = validateThemeDocument(row.document);
  if (result.ok)
    return {
      id: row.id,
      name: row.name,
      source: 'custom',
      appearance: result.document.appearance,
      primary: normalizeColor(result.document.colors.primary),
      document: result.document,
      valid: true,
      problems: [],
    };
  // Kept and listed so it can be fixed or deleted; never drawn.
  const raw = row.document as Partial<ThemeDocument>;
  return {
    id: row.id,
    name: row.name,
    source: 'custom',
    appearance: raw?.appearance === 'dark' ? 'dark' : 'light',
    primary: '',
    document: raw as ThemeDocument,
    valid: false,
    problems: result.problems,
  };
}

async function customRow(id: string): Promise<ThemeRow | undefined> {
  return db.query.themes.findFirst({ where: { id } });
}

/** A theme of the library by id, or undefined. */
export async function findTheme(id: string): Promise<ThemeEntry | undefined> {
  if (isThemePresetName(id)) return presetEntry(id);
  const row = await customRow(id);
  return row ? customEntry(row) : undefined;
}

function accentColor(accent: AccentName | null): string | null {
  return accent ? ACCENT_COLORS[accent] : null;
}

/** The theme drawn for a stored setting: its theme, or desk if unusable. */
async function activeEntry(config: UiThemeConfig): Promise<ThemeEntry> {
  const entry = await findTheme(config.theme);
  return entry?.valid ? entry : presetEntry(DEFAULT_THEME);
}

function stateOf(config: UiThemeConfig, theme: ThemeEntry): ThemeState {
  const accent = accentColor(config.accent);
  return {
    accent: config.accent,
    defaultAccent: DEFAULT_ACCENT,
    accents: ACCENT_NAMES.map((name) => ({ name, color: ACCENT_COLORS[name] })),
    dockLabels: config.dockLabels,
    theme,
    accentOverridesPrimary:
      accent !== null && normalizeColor(accent) !== theme.primary,
  };
}

/** Every token of a theme, with the accent applied. */
export function resolveEntry(
  entry: ThemeEntry,
  accent: AccentName | null,
): ResolvedTheme {
  return entry.source === 'preset' && isThemePresetName(entry.id)
    ? resolvePreset(entry.id, accentColor(accent))
    : resolveTheme(entry.document, {
        name: entry.name,
        source: 'custom',
        accent: accentColor(accent),
      });
}

export async function getThemeState(): Promise<ThemeState> {
  const config = await getPlatformConfig('ui.theme');
  return stateOf(config, await activeEntry(config));
}

/** The theme state, and every token of the active theme when asked. */
export async function getTheme(
  options: { resolve?: boolean } = {},
): Promise<{ theme: ThemeState; resolved: ResolvedTheme | null }> {
  const config = await getPlatformConfig('ui.theme');
  const active = await activeEntry(config);
  return {
    theme: stateOf(config, active),
    resolved: options.resolve ? resolveEntry(active, config.accent) : null,
  };
}

export type ThemeChange = {
  /** An accent name, or null to clear it. */
  accent?: string | null;
  dockLabels?: boolean;
  /** The theme to activate: a preset name or a custom theme's id. */
  theme?: string;
};

function badRequest(message: string): AppError {
  return new AppError(message, 400);
}

/** Text must stay readable with the accent that will be drawn on a theme. */
function checkWithAccent(entry: ThemeEntry, accent: AccentName | null): void {
  if (entry.source === 'preset' || !accent) return;
  const problems = contrastProblems(resolveEntry(entry, accent)).map(
    (problem) => ({
      ...problem,
      message: `With the ${accent} accent: ${problem.message}`,
    }),
  );
  if (problems.length) throw new ThemeValidationError(problems);
}

/**
 * Change the accent, the dock labels or the active theme. Each field left
 * out keeps its stored value; at least one must be given. Connected clients
 * are told to re-read the theme.
 */
export async function updateTheme(change: ThemeChange): Promise<ThemeState> {
  if (
    change.accent === undefined &&
    change.dockLabels === undefined &&
    change.theme === undefined
  )
    throw badRequest('Give an accent, the dock labels setting or a theme.');
  if (
    change.accent !== undefined &&
    change.accent !== null &&
    !isAccentName(change.accent)
  )
    throw badRequest(`Unknown accent. Use one of: ${ACCENT_NAMES.join(', ')}.`);
  let next: ThemeEntry | undefined;
  if (change.theme !== undefined) {
    next = await findTheme(change.theme);
    if (!next)
      throw new AppError(
        'No theme has this id. List them with hatch theme list.',
        404,
        { code: 'theme_not_found' },
      );
    if (!next.valid) throw new ThemeValidationError(next.problems);
  }
  const current = await getPlatformConfig('ui.theme');
  const accent =
    change.accent === undefined
      ? current.accent
      : (change.accent as AccentName | null);
  checkWithAccent(next ?? (await activeEntry(current)), accent);
  // Fields left out keep their latest stored value, even when another change
  // to the theme lands at the same moment.
  const config = await updatePlatformConfig('ui.theme', (stored) => ({
    accent: change.accent === undefined ? stored.accent : accent,
    dockLabels: change.dockLabels ?? stored.dockLabels,
    theme: change.theme ?? stored.theme,
  }));
  publishThemeUpdated(config);
  return stateOf(config, await activeEntry(config));
}

function publishThemeUpdated(config: UiThemeConfig): void {
  // `accent` stays in the event for clients that only know accents.
  publishPlatformEvent({
    type: 'theme.updated',
    accent: config.accent ?? DEFAULT_ACCENT,
  });
}

/** Back to `desk` with no accent; keeps dock labels and the library. */
export async function resetTheme(): Promise<ThemeState> {
  const config = await updatePlatformConfig('ui.theme', (current) => ({
    ...DEFAULT_UI_THEME,
    dockLabels: current.dockLabels,
  }));
  publishThemeUpdated(config);
  return stateOf(config, await activeEntry(config));
}

/** Choose the accent and keep the other theme settings. */
export function setThemeAccent(accent: string): Promise<ThemeState> {
  return updateTheme({ accent });
}

/** The library: presets first, then custom themes, oldest first. */
export async function listThemes(): Promise<ThemeEntry[]> {
  const rows = await db
    .select()
    .from(schema.themes)
    .orderBy(asc(schema.themes.createdAt), asc(schema.themes.id));
  return [...THEME_PRESET_NAMES.map(presetEntry), ...rows.map(customEntry)];
}

function nameTaken(name: string): AppError {
  return new AppError(
    `A theme named "${name}" already exists; choose another name.`,
    409,
    { code: 'theme_name_taken', params: { name } },
  );
}

/** Names pick one theme, ignoring case; preset names are taken too. */
async function assertNameFree(name: string, exceptId?: string): Promise<void> {
  const key = name.toLowerCase();
  const preset = THEME_PRESET_NAMES.some(
    (preset) => THEME_PRESETS[preset].document.name?.toLowerCase() === key,
  );
  const [row] = preset
    ? []
    : await db
        .select({ id: schema.themes.id })
        .from(schema.themes)
        .where(sql`lower(${schema.themes.name}) = ${key}`)
        .limit(1);
  if (preset || (row && row.id !== exceptId)) throw nameTaken(name);
}

/** Two saves racing for one name: the unique index decides. */
function isNameConflict(error: unknown): boolean {
  const cause =
    error && typeof error === 'object' && 'cause' in error && error.cause
      ? error.cause
      : error;
  // postgres.js names the index `constraint_name`; PGlite `constraint`.
  const { code, constraint, constraint_name } = (cause ?? {}) as {
    code?: unknown;
    constraint?: unknown;
    constraint_name?: unknown;
  };
  return (
    code === '23505' && (constraint_name ?? constraint) === 'themes_name_idx'
  );
}

function checkedDocument(document: unknown): ThemeDocument {
  const result = validateThemeDocument(document);
  if (!result.ok) throw new ThemeValidationError(result.problems);
  return result.document;
}

/** Save a new custom theme. It is not activated. */
export async function createTheme(document: unknown): Promise<ThemeEntry> {
  const checked = checkedDocument(document);
  const count = await db.$count(schema.themes);
  if (count >= MAX_CUSTOM_THEMES)
    throw new AppError(
      `An instance keeps at most ${MAX_CUSTOM_THEMES} custom themes; delete one first.`,
      409,
      { code: 'theme_library_full', params: { max: MAX_CUSTOM_THEMES } },
    );
  const name = checked.name ?? CUSTOM_NAME;
  await assertNameFree(name);
  const [row] = await db
    .insert(schema.themes)
    .values({ id: ulid().toLowerCase(), name, document: checked })
    .returning()
    .catch((error: unknown) => {
      throw isNameConflict(error) ? nameTaken(name) : error;
    });
  publishThemeUpdated(await getPlatformConfig('ui.theme'));
  return customEntry(row);
}

function customOnly(id: string): void {
  if (isThemePresetName(id))
    throw new AppError(
      'Presets cannot be changed or deleted; save a copy as a custom theme instead.',
      400,
      { code: 'theme_preset_readonly' },
    );
}

/**
 * Replace a custom theme's document whole. The active theme is also checked
 * with the chosen accent, since it is drawn with it.
 */
export async function updateCustomTheme(
  id: string,
  document: unknown,
): Promise<ThemeEntry> {
  customOnly(id);
  const checked = checkedDocument(document);
  const existing = await customRow(id);
  if (!existing)
    throw new AppError('No custom theme has this id.', 404, {
      code: 'theme_not_found',
    });
  const config = await getPlatformConfig('ui.theme');
  const name = checked.name ?? CUSTOM_NAME;
  await assertNameFree(name, id);
  if (config.theme === id)
    checkWithAccent(
      customEntry({ ...existing, name, document: checked }),
      config.accent,
    );
  const [row] = await db
    .update(schema.themes)
    .set({ name, document: checked, updatedAt: new Date() })
    .where(eq(schema.themes.id, id))
    .returning()
    .catch((error: unknown) => {
      throw isNameConflict(error) ? nameTaken(name) : error;
    });
  if (!row)
    throw new AppError('No custom theme has this id.', 404, {
      code: 'theme_not_found',
    });
  publishThemeUpdated(config);
  return customEntry(row);
}

/** Delete a custom theme. The active theme cannot be deleted. */
export async function deleteTheme(id: string): Promise<void> {
  customOnly(id);
  const config = await getPlatformConfig('ui.theme');
  if (config.theme === id)
    throw new AppError(
      'This theme is active. Activate another theme before deleting it.',
      409,
      { code: 'theme_active' },
    );
  const deleted = await db
    .delete(schema.themes)
    .where(eq(schema.themes.id, id))
    .returning({ id: schema.themes.id });
  if (!deleted.length)
    throw new AppError('No custom theme has this id.', 404, {
      code: 'theme_not_found',
    });
  publishThemeUpdated(config);
}

/** Check a document without saving it; optionally with the current accent. */
export async function validateTheme(
  document: unknown,
  options: { withCurrentAccent?: boolean } = {},
): Promise<
  | { ok: true; problems: []; resolved: ResolvedTheme }
  | { ok: false; problems: ThemeProblem[]; resolved: null }
> {
  const accent = options.withCurrentAccent
    ? (await getPlatformConfig('ui.theme')).accent
    : null;
  const result = validateThemeDocument(document, {
    accent: accentColor(accent),
  });
  if (!result.ok)
    return { ok: false, problems: result.problems, resolved: null };
  return {
    ok: true,
    problems: [],
    resolved: resolveTheme(result.document, {
      name: result.document.name ?? CUSTOM_NAME,
      source: 'custom',
      accent: accentColor(accent),
    }),
  };
}
