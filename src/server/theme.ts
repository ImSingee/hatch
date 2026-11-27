/** Server Functions for the signed-in user's theme (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware, requireSession } from './auth';
import { readTheme, updateTheme, type ThemeState } from './theme-settings';

/** The theme, with the user it belongs to so a cached copy can be checked. */
export type ThemeSettings = ThemeState & { userId: string };

export const getThemeFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<ThemeSettings> => {
    const { user } = await requireSession();
    return { userId: user.id, ...(await readTheme(user.id)) };
  });

export const setThemeAccentFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((accent: string) => z.string().min(1).max(32).parse(accent))
  .handler(async ({ data }): Promise<ThemeSettings> => {
    const { user } = await requireSession();
    return {
      userId: user.id,
      ...(await updateTheme(user.id, { accent: data })),
    };
  });

export const setDockLabelsFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((shown: boolean) => z.boolean().parse(shown))
  .handler(async ({ data }): Promise<ThemeSettings> => {
    const { user } = await requireSession();
    return {
      userId: user.id,
      ...(await updateTheme(user.id, { dockLabels: data })),
    };
  });
