/** Server-only: the theme a user's clients apply, kept per user. */
import { db, schema } from '~/db';
import { DEFAULT_HOMEPAGE } from '~/homepage';
import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  DEFAULT_ACCENT,
  isAccentName,
  type AccentName,
} from '~/ui/theme/accents';
import { AppError } from '~server/errors';
import { publishPlatformEvent } from '~server/platform-events';

export type ThemeState = {
  accent: AccentName;
  defaultAccent: AccentName;
  /** Every accent that can be chosen, in token order. */
  accents: { name: AccentName; color: string }[];
  /** Whether the web dock shows each tile's name under it; off by default. */
  dockLabels: boolean;
};

function themeState(row?: {
  accent: string | null;
  dockLabels: boolean | null;
}): ThemeState {
  return {
    // An accent the tokens no longer define reads as never picked.
    accent: isAccentName(row?.accent) ? row.accent : DEFAULT_ACCENT,
    defaultAccent: DEFAULT_ACCENT,
    accents: ACCENT_NAMES.map((name) => ({ name, color: ACCENT_COLORS[name] })),
    dockLabels: row?.dockLabels ?? false,
  };
}

/** The user's theme; a field they never set is the built-in default. */
export async function readTheme(userId: string): Promise<ThemeState> {
  return themeState(
    await db.query.userPreferences.findFirst({
      where: { userId },
      columns: { accent: true, dockLabels: true },
    }),
  );
}

/**
 * Change the user's theme. Each field left out keeps its stored value; at
 * least one must be given. The user's connected clients are told to re-read
 * the theme.
 */
export async function updateTheme(
  userId: string,
  change: { accent?: string; dockLabels?: boolean },
): Promise<ThemeState> {
  if (change.accent === undefined && change.dockLabels === undefined)
    throw new AppError('Give an accent or the dock labels setting.', 400);
  if (change.accent !== undefined && !isAccentName(change.accent))
    throw new AppError(
      `Unknown accent. Use one of: ${ACCENT_NAMES.join(', ')}.`,
      400,
    );
  const set = {
    ...(change.accent === undefined ? {} : { accent: change.accent }),
    ...(change.dockLabels === undefined
      ? {}
      : { dockLabels: change.dockLabels }),
  };
  // One upsert that only names the given columns: a field left out keeps its
  // latest stored value, even when another change lands at the same moment.
  const [row] = await db
    .insert(schema.userPreferences)
    // A first preference row needs a homepage; the default is what the
    // user already gets without one.
    .values({ userId, homepage: DEFAULT_HOMEPAGE, ...set })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { ...set, updatedAt: new Date() },
    })
    .returning({
      accent: schema.userPreferences.accent,
      dockLabels: schema.userPreferences.dockLabels,
    });
  const next = themeState(row);
  publishPlatformEvent({ type: 'theme.updated', userId, accent: next.accent });
  return next;
}
