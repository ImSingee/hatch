/**
 * Server-only: the themes clients draw.
 *
 * The library is shared: the presets (`desk`, `desk-dark`) and the custom
 * themes people and the Agent save on the web or with the CLI (`themes`
 * table). Which theme is active, the accent that replaces its primary and
 * the dock labels are each user's own (`user_preferences`); a new user draws
 * the default preset. A dark theme is a theme like any other; clients draw
 * the user's theme whatever their device prefers.
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
import { db, schema, type DB, type TX } from '~/db';
import { AppError } from '~server/errors';
import { DEFAULT_HOMEPAGE } from '~/homepage';
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
  /** The theme the user's clients draw. */
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

async function customRow(
  id: string,
  executor: DB | TX = db,
): Promise<ThemeRow | undefined> {
  return executor.query.themes.findFirst({ where: { id } });
}

/** A theme of the library by id, or undefined. */
export async function findTheme(
  id: string,
  executor: DB | TX = db,
): Promise<ThemeEntry | undefined> {
  if (isThemePresetName(id)) return presetEntry(id);
  const row = await customRow(id, executor);
  return row ? customEntry(row) : undefined;
}

function accentColor(accent: AccentName | null): string | null {
  return accent ? ACCENT_COLORS[accent] : null;
}

/** One user's theme settings, as stored. */
type PersonalTheme = {
  /** null: no accent, the active theme shows its own primary. */
  accent: AccentName | null;
  dockLabels: boolean;
  /** The active theme: a preset name or a custom theme's id. */
  theme: string;
};

/** A new user, and `theme reset`: `desk` with no accent. */
const DEFAULT_PERSONAL_THEME: PersonalTheme = {
  accent: null,
  dockLabels: false,
  theme: DEFAULT_THEME,
};

/**
 * The user's settings; without a user (a viewer who is not signed in) the
 * defaults. A stored accent the tokens no longer define reads as the
 * default accent, as the instance setting did.
 */
async function readPersonal(
  userId: string | null,
  executor: DB | TX = db,
): Promise<PersonalTheme> {
  if (!userId) return DEFAULT_PERSONAL_THEME;
  const row = await executor.query.userPreferences.findFirst({
    where: { userId },
    columns: {
      accent: true,
      dockLabels: true,
      themePreset: true,
      customThemeId: true,
    },
  });
  if (!row) return DEFAULT_PERSONAL_THEME;
  return {
    accent:
      row.accent === null
        ? null
        : isAccentName(row.accent)
          ? row.accent
          : DEFAULT_ACCENT,
    dockLabels: row.dockLabels ?? false,
    theme: row.customThemeId ?? row.themePreset ?? DEFAULT_THEME,
  };
}

/** The theme drawn for a user's setting: its theme, or desk if unusable. */
async function activeEntry(
  personal: PersonalTheme,
  executor: DB | TX = db,
): Promise<ThemeEntry> {
  const entry = await findTheme(personal.theme, executor);
  return entry?.valid ? entry : presetEntry(DEFAULT_THEME);
}

/**
 * The accent drawn on a theme. Users choose accents and share themes, so a
 * custom theme someone else edited can stop being readable with a user's
 * accent; it is then drawn with its own primary, never unreadable.
 */
function drawnAccent(
  entry: ThemeEntry,
  accent: AccentName | null,
): AccentName | null {
  if (entry.source === 'preset' || !accent) return accent;
  return contrastProblems(resolveEntry(entry, accent)).length ? null : accent;
}

function stateOf(personal: PersonalTheme, theme: ThemeEntry): ThemeState {
  const accent = accentColor(drawnAccent(theme, personal.accent));
  return {
    accent: personal.accent,
    defaultAccent: DEFAULT_ACCENT,
    accents: ACCENT_NAMES.map((name) => ({ name, color: ACCENT_COLORS[name] })),
    dockLabels: personal.dockLabels,
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

/** A user's theme state; without a user, the defaults. */
export async function getThemeState(
  userId: string | null,
): Promise<ThemeState> {
  const personal = await readPersonal(userId);
  return stateOf(personal, await activeEntry(personal));
}

/** A user's theme state, and every token of their theme when asked. */
export async function getTheme(
  userId: string | null,
  options: { resolve?: boolean } = {},
): Promise<{ theme: ThemeState; resolved: ResolvedTheme | null }> {
  const personal = await readPersonal(userId);
  const active = await activeEntry(personal);
  return {
    theme: stateOf(personal, active),
    resolved: options.resolve
      ? resolveEntry(active, drawnAccent(active, personal.accent))
      : null,
  };
}

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock;
// see the list in `pins.ts`.
const THEME_LIBRARY_LOCK_NS = 10;

/**
 * Run a library change or an activation under one lock, so a theme cannot
 * be deleted or replaced between being checked and being activated.
 */
function withThemeLock<T>(work: (tx: TX) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${THEME_LIBRARY_LOCK_NS}, 0)`,
    );
    return work(tx);
  });
}

/** Store a user's settings; a first preference row gets the default homepage. */
async function writePersonal(
  tx: TX,
  userId: string,
  next: PersonalTheme,
): Promise<void> {
  const preset = isThemePresetName(next.theme);
  const set = {
    accent: next.accent,
    dockLabels: next.dockLabels,
    themePreset: preset ? next.theme : null,
    customThemeId: preset ? null : next.theme,
  };
  await tx
    .insert(schema.userPreferences)
    .values({ userId, homepage: DEFAULT_HOMEPAGE, ...set })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { ...set, updatedAt: new Date() },
    });
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
 * Change the user's accent, dock labels or active theme. Each field left out
 * keeps its stored value; at least one must be given. The user's connected
 * clients are told to re-read the theme.
 */
export async function updateTheme(
  userId: string,
  change: ThemeChange,
): Promise<ThemeState> {
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
  // The theme's checks run under the library lock, so it cannot be deleted
  // or changed between being checked and being activated; fields left out
  // keep their latest stored value.
  const personal = await withThemeLock(async (tx) => {
    const stored = await readPersonal(userId, tx);
    let next: ThemeEntry | undefined;
    if (change.theme !== undefined) {
      next = await findTheme(change.theme, tx);
      if (!next)
        throw new AppError(
          'No theme has this id. List them with hatch theme list.',
          404,
          { code: 'theme_not_found' },
        );
      if (!next.valid) throw new ThemeValidationError(next.problems);
    }
    const accent =
      change.accent === undefined
        ? stored.accent
        : (change.accent as AccentName | null);
    checkWithAccent(next ?? (await activeEntry(stored, tx)), accent);
    const written: PersonalTheme = {
      accent,
      dockLabels: change.dockLabels ?? stored.dockLabels,
      theme: change.theme ?? stored.theme,
    };
    await writePersonal(tx, userId, written);
    return written;
  });
  publishThemeUpdated(userId, personal);
  return stateOf(personal, await activeEntry(personal));
}

function publishThemeUpdated(userId: string, personal: PersonalTheme): void {
  // `accent` stays in the event for clients that only know accents.
  publishPlatformEvent({
    type: 'theme.updated',
    userId,
    accent: personal.accent ?? DEFAULT_ACCENT,
  });
}

/** Tell every client the library changed; their theme may be in it. */
function publishLibraryUpdated(): void {
  publishPlatformEvent({ type: 'themes.updated' });
}

/** The user back on `desk` with no accent; keeps dock labels. */
export async function resetTheme(userId: string): Promise<ThemeState> {
  const personal = await withThemeLock(async (tx) => {
    const stored = await readPersonal(userId, tx);
    const written = {
      ...DEFAULT_PERSONAL_THEME,
      dockLabels: stored.dockLabels,
    };
    await writePersonal(tx, userId, written);
    return written;
  });
  publishThemeUpdated(userId, personal);
  return stateOf(personal, await activeEntry(personal));
}

/** Choose the user's accent and keep their other theme settings. */
export function setThemeAccent(
  userId: string,
  accent: string,
): Promise<ThemeState> {
  return updateTheme(userId, { accent });
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
async function assertNameFree(
  executor: DB | TX,
  name: string,
  exceptId?: string,
): Promise<void> {
  const key = name.toLowerCase();
  const preset = THEME_PRESET_NAMES.some(
    (preset) => THEME_PRESETS[preset].document.name?.toLowerCase() === key,
  );
  const [row] = preset
    ? []
    : await executor
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
  const name = checked.name ?? CUSTOM_NAME;
  const row = await withThemeLock(async (tx) => {
    const count = await tx.$count(schema.themes);
    if (count >= MAX_CUSTOM_THEMES)
      throw new AppError(
        `An instance keeps at most ${MAX_CUSTOM_THEMES} custom themes; delete one first.`,
        409,
        { code: 'theme_library_full', params: { max: MAX_CUSTOM_THEMES } },
      );
    await assertNameFree(tx, name);
    const [row] = await tx
      .insert(schema.themes)
      .values({ id: ulid().toLowerCase(), name, document: checked })
      .returning()
      .catch((error: unknown) => {
        throw isNameConflict(error) ? nameTaken(name) : error;
      });
    return row;
  });
  publishLibraryUpdated();
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
 * Replace a custom theme's document whole. When the editor has it active it
 * is also checked with their accent, since they draw it with it; other users
 * whose accent no longer reads on it draw its own primary (`drawnAccent`).
 */
export async function updateCustomTheme(
  editorId: string | null,
  id: string,
  document: unknown,
): Promise<ThemeEntry> {
  customOnly(id);
  const checked = checkedDocument(document);
  const name = checked.name ?? CUSTOM_NAME;
  // Under the library lock: the theme cannot be activated (and checked with
  // an accent) while it is replaced.
  const row = await withThemeLock(async (tx) => {
    const editor = await readPersonal(editorId, tx);
    const existing = await customRow(id, tx);
    if (!existing)
      throw new AppError('No custom theme has this id.', 404, {
        code: 'theme_not_found',
      });
    await assertNameFree(tx, name, id);
    if (editor.theme === id)
      checkWithAccent(
        customEntry({ ...existing, name, document: checked }),
        editor.accent,
      );
    const [row] = await tx
      .update(schema.themes)
      .set({ name, document: checked, updatedAt: new Date() })
      .where(eq(schema.themes.id, id))
      .returning()
      .catch((error: unknown) => {
        throw isNameConflict(error) ? nameTaken(name) : error;
      });
    return row;
  });
  publishLibraryUpdated();
  return customEntry(row);
}

/**
 * Delete a custom theme of the shared library. The caller's own active theme
 * cannot be deleted; other users who have it active fall back to the default
 * preset (the foreign key clears their choice).
 */
export async function deleteTheme(
  callerId: string | null,
  id: string,
): Promise<void> {
  customOnly(id);
  // Under the library lock, so the theme cannot be activated between the
  // check and the delete.
  await withThemeLock(async (tx) => {
    if ((await readPersonal(callerId, tx)).theme === id)
      throw new AppError(
        'This theme is active. Activate another theme before deleting it.',
        409,
        { code: 'theme_active' },
      );
    const deleted = await tx
      .delete(schema.themes)
      .where(eq(schema.themes.id, id))
      .returning({ id: schema.themes.id });
    if (!deleted.length)
      throw new AppError('No custom theme has this id.', 404, {
        code: 'theme_not_found',
      });
  });
  publishLibraryUpdated();
}

/**
 * Check a document without saving it; optionally with the accent of
 * `accentOf` (the caller), none when there is no user.
 */
export async function validateTheme(
  document: unknown,
  options: { withCurrentAccent?: boolean; accentOf?: string | null } = {},
): Promise<
  | { ok: true; problems: []; resolved: ResolvedTheme }
  | { ok: false; problems: ThemeProblem[]; resolved: null }
> {
  const accent = options.withCurrentAccent
    ? (await readPersonal(options.accentOf ?? null)).accent
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
