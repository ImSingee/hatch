/** Server-only: a user's personal Desk preferences. */
import { db, schema } from '~/db';
import {
  DEFAULT_BACKGROUND_APP_MINUTES,
  MAX_BACKGROUND_APP_MINUTES,
  MIN_BACKGROUND_APP_MINUTES,
  isBackgroundAppMinutes,
} from '~/desk-preferences';
import { DEFAULT_HOMEPAGE } from '~/homepage';
import { AppError } from './errors';

export type DeskPreferences = {
  /** Minutes a minimised App keeps running before the Desk stops it. */
  backgroundAppMinutes: number;
};

export async function readDeskPreferences(
  userId: string,
): Promise<DeskPreferences> {
  const row = await db.query.userPreferences.findFirst({
    where: { userId },
    columns: { deskBackgroundMinutes: true },
  });
  return {
    backgroundAppMinutes: isBackgroundAppMinutes(row?.deskBackgroundMinutes)
      ? row.deskBackgroundMinutes
      : DEFAULT_BACKGROUND_APP_MINUTES,
  };
}

/** Apply the given fields; omitted fields keep their current value. */
export async function updateDeskPreferences(
  userId: string,
  input: Partial<DeskPreferences>,
): Promise<DeskPreferences> {
  const minutes = input.backgroundAppMinutes;
  if (minutes === undefined) return readDeskPreferences(userId);
  if (!isBackgroundAppMinutes(minutes)) {
    throw new AppError(
      `Background app minutes must be a whole number from ${MIN_BACKGROUND_APP_MINUTES} to ${MAX_BACKGROUND_APP_MINUTES}.`,
      400,
    );
  }
  await db
    .insert(schema.userPreferences)
    // A first preference row needs a homepage; the default is what the
    // user already gets without one.
    .values({
      userId,
      homepage: DEFAULT_HOMEPAGE,
      deskBackgroundMinutes: minutes,
    })
    .onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: { deskBackgroundMinutes: minutes, updatedAt: new Date() },
    });
  return { backgroundAppMinutes: minutes };
}
