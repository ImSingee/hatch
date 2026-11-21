import { readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/hatch-icon-test-${process.pid}-${Date.now()}`;
  process.env.HATCH_DATA_DIR = dir;
  return dir;
});

vi.mock('~/db', async () => {
  const { createTestDb } = await import('~/db/test-db');
  return createTestDb();
});

const { db, schema } = await import('~/db');
const {
  APP_ICON_SIZES,
  clearAppIcon,
  encodeAppIcon,
  getAppIcon,
  readAppIcon,
  removeAppIconFiles,
  setAppIcon,
} = await import('./icon');
const { appIconDir } = await import('~agent/paths');

const APP_ID = 'icon-test-app';
const image = (
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp',
) =>
  sharp({
    create: { width, height, channels: 3, background: '#2F9E68' },
  })
    [format]()
    .toBuffer();
const isPng = (bytes: Buffer) =>
  bytes.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n';

beforeEach(async () => {
  await db.delete(schema.apps);
  await db
    .insert(schema.apps)
    .values({ id: APP_ID, slug: 'icon-test', name: 'Icon Test' });
  await rm(dataDir, { recursive: true, force: true });
});

afterAll(() => rm(dataDir, { recursive: true, force: true }));

describe('encodeAppIcon', () => {
  it('re-encodes an accepted image into one square PNG per size', async () => {
    const source = await image(900, 600, 'jpeg');
    const encoded = await encodeAppIcon(source);

    expect([...encoded.keys()]).toEqual([...APP_ICON_SIZES]);
    for (const [size, png] of encoded) {
      expect(isPng(png)).toBe(true);
      const meta = await sharp(png).metadata();
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
  });

  it('rejects input that is not a bounded PNG, JPEG or WebP image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const cases: [Buffer, number][] = [
      [Buffer.alloc(0), 400],
      [svg, 415],
      [Buffer.from('GIF89a' + 'x'.repeat(64), 'latin1'), 415],
      // A PNG signature in front of non-image bytes must not be trusted.
      [Buffer.concat([pngHeader, svg]), 400],
      [await image(32, 32, 'png'), 400],
      [await image(4100, 64, 'png'), 400],
      [Buffer.concat([pngHeader, Buffer.alloc(4 * 1024 * 1024)]), 413],
    ];
    for (const [bytes, status] of cases)
      await expect(encodeAppIcon(bytes)).rejects.toMatchObject({ status });
  });
});

describe('App icon storage', () => {
  it('stores only the current icon and reports it on the App', async () => {
    const first = await setAppIcon(APP_ID, await image(256, 256, 'png'));
    const second = await setAppIcon(APP_ID, await image(256, 256, 'webp'));

    expect(second.key).not.toBe(first.key);
    expect(second.path).toBe(`/api/app/${APP_ID}/icon?v=${second.key}`);
    expect(await getAppIcon(APP_ID)).toEqual(second);
    // Replacing an icon leaves no file of the previous one behind.
    expect((await readdir(appIconDir(APP_ID))).sort()).toEqual(
      APP_ICON_SIZES.map((size) => `${second.key}-${size}.png`).sort(),
    );
    const served = await readAppIcon(APP_ID, 64);
    expect(served?.key).toBe(second.key);
    expect(isPng(served!.body)).toBe(true);
  });

  it('keeps the files of whichever concurrent replacement wins', async () => {
    const source = await image(128, 128, 'png');
    await Promise.all([
      setAppIcon(APP_ID, source),
      setAppIcon(APP_ID, source),
      setAppIcon(APP_ID, source),
      clearAppIcon(APP_ID),
    ]);

    const current = await getAppIcon(APP_ID);
    const names = await readdir(appIconDir(APP_ID)).catch(() => []);
    expect(names.sort()).toEqual(
      current.key
        ? APP_ICON_SIZES.map((size) => `${current.key}-${size}.png`).sort()
        : [],
    );
  });

  it('clears the icon and its files', async () => {
    await setAppIcon(APP_ID, await image(128, 128, 'png'));

    expect(await clearAppIcon(APP_ID)).toEqual({
      key: null,
      path: null,
      sizes: [],
    });
    expect(await readAppIcon(APP_ID, 64)).toBeNull();
    expect(await readdir(appIconDir(APP_ID))).toEqual([]);
  });

  it('removes every icon file when an App is deleted', async () => {
    await setAppIcon(APP_ID, await image(128, 128, 'png'));
    await removeAppIconFiles(APP_ID);
    await expect(readdir(appIconDir(APP_ID))).rejects.toThrow('ENOENT');
  });

  it('rejects unknown Apps and ids that could escape the icon root', async () => {
    const png = await image(128, 128, 'png');
    for (const id of ['missing-app', '../escape', 'a/b'])
      await expect(setAppIcon(id, png)).rejects.toMatchObject({ status: 404 });
    expect(await readAppIcon('../escape', 64)).toBeNull();
  });
});
