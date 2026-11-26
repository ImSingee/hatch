/** Server Functions for the instance theme (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
import {
  getTheme,
  setThemeAccent,
  updateTheme,
  type ThemeState,
} from './theme-settings';
import type { ResolvedTheme } from '../../packages/hatch-design-tokens/src';

/** The theme state with both appearances resolved, as the Web UI draws it. */
export type WebTheme = ThemeState & {
  resolved: { light: ResolvedTheme; dark: ResolvedTheme };
};

async function webTheme(): Promise<WebTheme> {
  const {
    theme,
    resolved: [light, dark],
  } = await getTheme(['light', 'dark']);
  return { ...theme, resolved: { light, dark } };
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

const appearanceSchema = z.enum(['light', 'dark']);

/** Mode and presets from the appearance settings; custom themes come from the CLI. */
export const setThemeAppearanceFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((change: unknown) =>
    z
      .object({
        mode: z.enum(['light', 'dark', 'system']).optional(),
        theme: z
          .object({
            appearance: appearanceSchema,
            preset: z.string().min(1).max(32),
          })
          .optional(),
      })
      .refine((value) => value.mode !== undefined || value.theme !== undefined)
      .parse(change),
  )
  .handler(async ({ data }) => {
    await updateTheme(data);
    return webTheme();
  });
