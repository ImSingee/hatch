/** Server-only: a user's personal Web UI preferences. */
import { db, schema } from '~/db';
import { DEFAULT_HOMEPAGE } from '~/homepage';
import { LOCALES, isLocale, type Locale } from '~i18n/locale';
import { AppError } from './errors';

export type InterfacePreferences = {
  /** The interface language; null until the user picks one. */
  language: Locale | null;
};

export async function readInterfacePreferences(
  userId: string,
): Promise<InterfacePreferences> {
  const row = await db.query.userPreferences.findFirst({
    where: { userId },
    columns: { language: true },
  });
  // A language whose catalog was removed reads as never picked.
  return { language: isLocale(row?.language) ? row.language : null };
}

/** Apply the given fields; omitted fields keep their current value. */
export async function updateInterfacePreferences(
  userId: string,
  input: { language?: Locale },
): Promise<InterfacePreferences> {
  if (input.language === undefined) return readInterfacePreferences(userId);
  if (!isLocale(input.language)) {
    throw new AppError(`Language must be one of: ${LOCALES.join(', ')}.`, 400);
  }
  const language = input.language;
  await db
    .insert(schema.userPreferences)
    // A first preference row needs a homepage; the default is what the
    // user already gets without one.
    .values({ userId, homepage: DEFAULT_HOMEPAGE, language })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { language, updatedAt: new Date() },
    });
  return { language };
}
