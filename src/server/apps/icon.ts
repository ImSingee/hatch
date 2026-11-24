/**
 * Server-only: an App's icon.
 *
 * The only persisted state is `apps.icon` (a key naming the current files)
 * and the re-encoded PNGs under the App's icon directory. Input bytes are
 * validated, decoded and re-encoded; they are never stored or served as-is.
 */
import { rm } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { appIconDir } from '~agent/paths';
import { db, schema } from '~/db';
import { AppError } from '~server/errors';
import { readCandidate } from '~server/images/candidates';
import {
  encodeSquareImage,
  MAX_SQUARE_IMAGE_BYTES,
  readSquareImage,
  removeSquareImageKey,
  writeSquareImage,
} from '~server/images/square-image';
import { isValidAppId } from './manifest';

export const APP_ICON_SIZES = [64, 128, 256] as const;
export type AppIconSize = (typeof APP_ICON_SIZES)[number];
export const MAX_APP_ICON_BYTES = MAX_SQUARE_IMAGE_BYTES;

export type AppIconView = {
  /** Null when the App shows its monogram. */
  key: string | null;
  /** Authenticated path; append `&size=64|128|256` (default 128). */
  path: string | null;
  sizes: number[];
};

export function appIconPath(id: string, key: string): string {
  return `/api/app/${encodeURIComponent(id)}/icon?v=${key}`;
}

export function appIconView(id: string, key: string | null): AppIconView {
  return {
    key,
    path: key ? appIconPath(id, key) : null,
    sizes: key ? [...APP_ICON_SIZES] : [],
  };
}

/** Validate an image and return one square PNG per stored size. */
export function encodeAppIcon(
  bytes: Buffer,
): Promise<Map<AppIconSize, Buffer>> {
  return encodeSquareImage(bytes, 'Icon', APP_ICON_SIZES, 'app.icon');
}

async function requireApp(id: string) {
  const app = isValidAppId(id)
    ? await db.query.apps.findFirst({
        where: { id },
        columns: { id: true, icon: true },
      })
    : undefined;
  if (!app) throw new AppError('App not found.', 404, { code: 'app.notFound' });
  return app;
}

export async function getAppIcon(id: string): Promise<AppIconView> {
  const app = await requireApp(id);
  return appIconView(app.id, app.icon);
}

/**
 * Point the App at `key` (or at no icon) and return the key it replaces.
 *
 * The row lock makes concurrent set/clear calls agree on one order, so each
 * caller learns exactly which key it superseded and removes only those files.
 * Returns `undefined` when the App no longer exists.
 */
async function swapIconKey(
  id: string,
  key: string | null,
): Promise<string | null | undefined> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ icon: schema.apps.icon })
      .from(schema.apps)
      .where(eq(schema.apps.id, id))
      .for('update');
    if (!current) return undefined;
    await tx
      .update(schema.apps)
      .set({ icon: key })
      .where(eq(schema.apps.id, id));
    return current.icon;
  });
}

function removeIconKeyFiles(id: string, key: string | null) {
  return removeSquareImageKey(appIconDir(id), key, APP_ICON_SIZES);
}

export async function setAppIcon(
  id: string,
  bytes: Buffer,
): Promise<AppIconView> {
  const app = await requireApp(id);
  const encoded = await encodeAppIcon(bytes);
  const key = await writeSquareImage(appIconDir(app.id), encoded);
  const previous = await swapIconKey(app.id, key);
  if (previous === undefined) {
    // The App was deleted meanwhile; leave nothing behind.
    await removeIconKeyFiles(app.id, key);
    throw new AppError('App not found.', 404, { code: 'app.notFound' });
  }
  await removeIconKeyFiles(app.id, previous);
  return appIconView(app.id, key);
}

export async function setAppIconFromCandidate(
  id: string,
  candidateId: string,
): Promise<AppIconView> {
  const bytes = await readCandidate(candidateId);
  if (!bytes) throw new AppError('Image candidate not found or expired.', 404);
  return setAppIcon(id, bytes);
}

export async function clearAppIcon(id: string): Promise<AppIconView> {
  const app = await requireApp(id);
  const previous = await swapIconKey(app.id, null);
  if (previous === undefined)
    throw new AppError('App not found.', 404, { code: 'app.notFound' });
  await removeIconKeyFiles(app.id, previous);
  return appIconView(app.id, null);
}

/** Delete every stored icon file of an App (used when the App is removed). */
export async function removeAppIconFiles(id: string): Promise<void> {
  await rm(appIconDir(id), { recursive: true, force: true });
}

export async function readAppIcon(
  id: string,
  size: AppIconSize,
): Promise<{ key: string; body: Buffer } | null> {
  const app = isValidAppId(id)
    ? await db.query.apps.findFirst({
        where: { id },
        columns: { id: true, icon: true },
      })
    : undefined;
  return app ? readSquareImage(appIconDir(app.id), app.icon, size) : null;
}
