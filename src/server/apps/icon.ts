/**
 * Server-only: an App's icon.
 *
 * The only persisted state is `apps.icon` (a key naming the current files)
 * and the re-encoded PNGs under the App's icon directory. Input bytes are
 * validated, decoded and re-encoded; they are never stored or served as-is.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { appIconDir } from '~agent/paths';
import { db, schema } from '~/db';
import { AppError } from '~server/errors';
import { readCandidate } from '~server/images/candidates';
import { isValidAppId } from './manifest';

export const APP_ICON_SIZES = [64, 128, 256] as const;
export type AppIconSize = (typeof APP_ICON_SIZES)[number];
export const MAX_APP_ICON_BYTES = 4 * 1024 * 1024;
const MIN_SIDE = 64;
const MAX_SIDE = 4096;
const KEY_RE = /^[0-9a-z]{26}$/;

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

function isAcceptedFormat(bytes: Buffer): boolean {
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return png || jpeg || webp;
}

/** Validate an image and return one square PNG per stored size. */
export async function encodeAppIcon(
  bytes: Buffer,
): Promise<Map<AppIconSize, Buffer>> {
  if (!bytes.byteLength) throw new AppError('Icon image is empty.', 400);
  if (bytes.byteLength > MAX_APP_ICON_BYTES)
    throw new AppError('Icon image exceeds 4 MB.', 413);
  if (!isAcceptedFormat(bytes))
    throw new AppError('Icon must be a PNG, JPEG or WebP image.', 415);
  try {
    const options = { limitInputPixels: MAX_SIDE * MAX_SIDE };
    const meta = await sharp(bytes, options).metadata();
    if (
      !meta.width ||
      !meta.height ||
      Math.min(meta.width, meta.height) < MIN_SIDE ||
      Math.max(meta.width, meta.height) > MAX_SIDE
    )
      throw new AppError(
        `Icon sides must be ${MIN_SIDE} to ${MAX_SIDE} pixels.`,
        400,
      );
    const encoded = new Map<AppIconSize, Buffer>();
    for (const size of APP_ICON_SIZES)
      encoded.set(
        size,
        await sharp(bytes, options)
          .rotate()
          .resize(size, size, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer(),
      );
    return encoded;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Icon image could not be decoded.', 400);
  }
}

async function requireApp(id: string) {
  const app = isValidAppId(id)
    ? await db.query.apps.findFirst({
        where: { id },
        columns: { id: true, icon: true },
      })
    : undefined;
  if (!app) throw new AppError('App not found.', 404);
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

/**
 * Remove the files of one icon key. Other keys and the directory itself are
 * kept: a concurrent writer may already have created the directory for its
 * own files. The directory goes away with the App.
 */
async function removeIconKeyFiles(id: string, key: string | null) {
  if (!key || !KEY_RE.test(key)) return;
  const dir = appIconDir(id);
  await Promise.all(
    APP_ICON_SIZES.map((size) =>
      rm(path.join(dir, `${key}-${size}.png`), { force: true }),
    ),
  );
}

export async function setAppIcon(
  id: string,
  bytes: Buffer,
): Promise<AppIconView> {
  const app = await requireApp(id);
  const encoded = await encodeAppIcon(bytes);
  const dir = appIconDir(app.id);
  const key = ulid().toLowerCase();
  await mkdir(dir, { recursive: true });
  for (const [size, png] of encoded) {
    const target = path.join(dir, `${key}-${size}.png`);
    await writeFile(`${target}.tmp`, png);
    await rename(`${target}.tmp`, target);
  }
  const previous = await swapIconKey(app.id, key);
  if (previous === undefined) {
    // The App was deleted meanwhile; leave nothing behind.
    await removeIconKeyFiles(app.id, key);
    throw new AppError('App not found.', 404);
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
  if (previous === undefined) throw new AppError('App not found.', 404);
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
  if (!app?.icon || !KEY_RE.test(app.icon)) return null;
  const body = await readFile(
    path.join(appIconDir(app.id), `${app.icon}-${size}.png`),
  ).catch(() => null);
  return body ? { key: app.icon, body } : null;
}
