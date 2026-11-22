/** Server Functions for the instance theme (Web UI). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from './auth';
import { getThemeState, setThemeAccent } from './theme-settings';

/**
 * Public on purpose: the login page is drawn in the chosen accent, and the
 * accent names are not private.
 */
export const getThemeFn = createServerFn({ method: 'GET' }).handler(() =>
  getThemeState(),
);

export const setThemeAccentFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((accent: string) => z.string().min(1).max(32).parse(accent))
  .handler(({ data }) => setThemeAccent(data));
