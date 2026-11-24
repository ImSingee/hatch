/**
 * Server-only: square images stored as re-encoded PNGs (App icons, user
 * avatars).
 *
 * Input bytes are validated, decoded and re-encoded; they are never stored or
 * served as-is. Each image is stored as one `<key>-<size>.png` file per size
 * in its owner's directory, and the owner's database row names the current
 * key. Writers create files under a fresh key before pointing the row at it,
 * then delete the files of the key they replaced.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ulid } from 'ulid';
import { AppError } from '~server/errors';

export const MAX_SQUARE_IMAGE_BYTES = 4 * 1024 * 1024;
const MIN_SIDE = 64;
const MAX_SIDE = 4096;
const KEY_RE = /^[0-9a-z]{26}$/;

export function isSquareImageKey(value: string): boolean {
  return KEY_RE.test(value);
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

/**
 * Validate an image and return one centre-cropped square PNG per size.
 * `noun` names the image in error messages ("Icon", "Avatar").
 */
export async function encodeSquareImage<S extends number>(
  bytes: Buffer,
  noun: string,
  sizes: readonly S[],
): Promise<Map<S, Buffer>> {
  if (!bytes.byteLength) throw new AppError(`${noun} image is empty.`, 400);
  if (bytes.byteLength > MAX_SQUARE_IMAGE_BYTES)
    throw new AppError(`${noun} image exceeds 4 MB.`, 413);
  if (!isAcceptedFormat(bytes))
    throw new AppError(`${noun} must be a PNG, JPEG or WebP image.`, 415);
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
        `${noun} sides must be ${MIN_SIDE} to ${MAX_SIDE} pixels.`,
        400,
      );
    const encoded = new Map<S, Buffer>();
    for (const size of sizes)
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
    throw new AppError(`${noun} image could not be decoded.`, 400);
  }
}

const fileName = (key: string, size: number) => `${key}-${size}.png`;

/** Write every size under a fresh key and return that key. */
export async function writeSquareImage(
  dir: string,
  encoded: Map<number, Buffer>,
): Promise<string> {
  const key = ulid().toLowerCase();
  await mkdir(dir, { recursive: true });
  for (const [size, png] of encoded) {
    const target = path.join(dir, fileName(key, size));
    await writeFile(`${target}.tmp`, png);
    await rename(`${target}.tmp`, target);
  }
  return key;
}

/**
 * Remove the files of one key. Other keys and the directory itself are kept:
 * a concurrent writer may already have created the directory for its own
 * files. The directory goes away with its owner.
 */
export async function removeSquareImageKey(
  dir: string,
  key: string | null,
  sizes: readonly number[],
): Promise<void> {
  if (!key || !isSquareImageKey(key)) return;
  await Promise.all(
    sizes.map((size) =>
      rm(path.join(dir, fileName(key, size)), { force: true }),
    ),
  );
}

/** Read one stored size, or null when the key or its file is missing. */
export async function readSquareImage(
  dir: string,
  key: string | null,
  size: number,
): Promise<{ key: string; body: Buffer } | null> {
  if (!key || !isSquareImageKey(key)) return null;
  const body = await readFile(path.join(dir, fileName(key, size))).catch(
    () => null,
  );
  return body ? { key, body } : null;
}
