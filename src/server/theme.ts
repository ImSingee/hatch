/**
 * Server Functions for themes (Web UI): the signed-in user's own active
 * theme, accent and dock labels, and the shared library of custom themes.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
import {
  createTheme,
  deleteTheme,
  getTheme,
  listThemes,
  setThemeAccent,
  updateCustomTheme,
  updateTheme,
  type ThemeEntry,
  type ThemeState,
} from './theme-settings';
import { ThemeValidationError } from './theme-errors';
import type {
  ResolvedTheme,
  ThemeProblem,
} from '../../packages/hatch-design-tokens/src';

/**
 * The user's theme state with their theme resolved, as the Web UI draws it,
 * and the user it belongs to so a cached copy can be checked.
 */
export type WebTheme = ThemeState & { resolved: ResolvedTheme; userId: string };

async function webTheme(userId: string): Promise<WebTheme> {
  const { theme, resolved } = await getTheme(userId, { resolve: true });
  return { ...theme, resolved: resolved!, userId };
}

/** The signed-in user's theme. The sign-in page draws this browser's cache. */
export const getThemeFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => webTheme((await requireSession()).user.id));

export const setThemeAccentFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((accent: string | null) =>
    z.string().min(1).max(32).nullable().parse(accent),
  )
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    await (data === null
      ? updateTheme(user.id, { accent: null })
      : setThemeAccent(user.id, data));
    return webTheme(user.id);
  });

export const setDockLabelsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((shown: boolean) => z.boolean().parse(shown))
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    await updateTheme(user.id, { dockLabels: data });
    return webTheme(user.id);
  });

const themeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/** The shared theme library: presets, then custom themes. */
export const listThemesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listThemes());

/** Make a theme of the library the one the user's clients draw. */
export const activateThemeFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => themeId.parse(id))
  .handler(async ({ data }) => {
    const { user } = await requireSession();
    await updateTheme(user.id, { theme: data });
    return webTheme(user.id);
  });

/**
 * A rejected document is an answer, not an error: the editor shows each
 * problem next to its field, translated from its code.
 */
export type SaveThemeResult =
  | { ok: true; theme: ThemeEntry }
  | { ok: false; problems: ThemeProblem[] };

/** Save a custom theme: a new one, or a whole replacement of `id`. */
export const saveThemeFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: unknown) =>
    z.object({ id: themeId.optional(), document: z.unknown() }).parse(input),
  )
  .handler(async ({ data }): Promise<SaveThemeResult> => {
    try {
      const theme = data.id
        ? await updateCustomTheme(
            (await requireSession()).user.id,
            data.id,
            data.document,
          )
        : await createTheme(data.document);
      return { ok: true, theme };
    } catch (error) {
      if (error instanceof ThemeValidationError)
        return { ok: false, problems: error.problems };
      throw error;
    }
  });

export const deleteThemeFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => themeId.parse(id))
  .handler(async ({ data }) => {
    await deleteTheme((await requireSession()).user.id, data);
    return { deleted: data };
  });
