import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { LOCALES } from '~i18n/locale';
import { authMiddleware, requireSession } from './auth';
import {
  readInterfacePreferences,
  updateInterfacePreferences,
  type InterfacePreferences,
} from './interface-preferences';

export type InterfacePreferenceSettings = InterfacePreferences & {
  userId: string;
};

export const getInterfacePreferenceSettings = createServerFn({
  method: 'GET',
})
  .middleware([authMiddleware])
  .handler(async (): Promise<InterfacePreferenceSettings> => {
    const { user } = await requireSession();
    return { userId: user.id, ...(await readInterfacePreferences(user.id)) };
  });

export const updateInterfacePreferenceSettings = createServerFn({
  method: 'POST',
})
  .middleware([authMiddleware])
  .validator(
    (input: { language: NonNullable<InterfacePreferences['language']> }) =>
      z.object({ language: z.enum(LOCALES) }).parse(input),
  )
  .handler(async ({ data }): Promise<InterfacePreferenceSettings> => {
    const { user } = await requireSession();
    return {
      userId: user.id,
      ...(await updateInterfacePreferences(user.id, data)),
    };
  });
