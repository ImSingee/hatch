/** Server Functions for the instance theme (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
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

/** The theme state with the active theme resolved, as the Web UI draws it. */
export type WebTheme = ThemeState & { resolved: ResolvedTheme };

async function webTheme(): Promise<WebTheme> {
  const { theme, resolved } = await getTheme({ resolve: true });
  return { ...theme, resolved: resolved! };
}

/**
 * Public on purpose: the login page is drawn in the instance theme, and
 * themes are not private.
 */
export const getThemeFn = createServerFn({ method: 'GET' }).handler(() =>
  webTheme(),
);

export const setThemeAccentFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((accent: string | null) =>
    z.string().min(1).max(32).nullable().parse(accent),
  )
  .handler(async ({ data }) => {
    await (data === null
      ? updateTheme({ accent: null })
      : setThemeAccent(data));
    return webTheme();
  });

export const setDockLabelsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((shown: boolean) => z.boolean().parse(shown))
  .handler(async ({ data }) => {
    await updateTheme({ dockLabels: data });
    return webTheme();
  });

const themeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/** The theme library: presets, then custom themes. */
export const listThemesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(() => listThemes());

/** Make a theme of the library the one every client draws. */
export const activateThemeFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => themeId.parse(id))
  .handler(async ({ data }) => {
    await updateTheme({ theme: data });
    return webTheme();
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
        ? await updateCustomTheme(data.id, data.document)
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
    await deleteTheme(data);
    return { deleted: data };
  });
