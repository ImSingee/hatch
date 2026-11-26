import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  MAX_BACKGROUND_APP_MINUTES,
  MIN_BACKGROUND_APP_MINUTES,
} from '~/desk-preferences';
import { authMiddleware, requireSession } from './auth';
import {
  type DeskPreferences,
  readDeskPreferences,
  updateDeskPreferences,
} from './desk-preferences';

export const getDeskPreferenceSettings = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<DeskPreferences> => {
    const { user } = await requireSession();
    return readDeskPreferences(user.id);
  });

export const updateDeskPreferenceSettings = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { backgroundAppMinutes: number }) =>
    z
      .object({
        backgroundAppMinutes: z
          .number()
          .int()
          .min(MIN_BACKGROUND_APP_MINUTES)
          .max(MAX_BACKGROUND_APP_MINUTES),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<DeskPreferences> => {
    const { user } = await requireSession();
    return updateDeskPreferences(user.id, data);
  });
