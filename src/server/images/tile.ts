/**
 * Server-only: turn a white-on-black glyph drawing into an App icon tile.
 *
 * Image models are good at one bold glyph but drift on background colour and
 * margins. The platform therefore owns both: luminance becomes the glyph's
 * opacity, the glyph is scaled to a fixed share of the tile, and it is laid
 * on an exact solid colour. Corners stay square; the UI rounds them.
 */
import sharp from 'sharp';
import { AppError } from '~server/errors';

export const TILE_SIZE = 512;
/** Share of the tile's side taken by the glyph's longer side. */
const GLYPH_SHARE = 0.58;
/** Luminance at or below this is background; at or above WHITE is solid. */
const BLACK = 40;
const WHITE = 215;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isTileColor(value: string): boolean {
  return HEX_RE.test(value);
}

export async function composeGlyphTile(
  drawing: Buffer,
  background: string,
): Promise<Buffer> {
  if (!isTileColor(background))
    throw new AppError('Tile background must be a #RRGGBB colour.', 400);
  const { data, info } = await sharp(drawing, { limitInputPixels: 4096 * 4096 })
    .flatten({ background: '#000000' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let lit = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] <= BLACK + 24) continue;
      lit += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  // An empty drawing, or one whose ground is not dark, is not a glyph.
  if (right < 0 || lit > width * height * 0.6)
    throw new AppError('The image is not a white glyph on black.', 400);

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;
  const glyph = Buffer.alloc(cropWidth * cropHeight * 4, 255);
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const value = data[(y + top) * width + x + left];
      glyph[(y * cropWidth + x) * 4 + 3] =
        value <= BLACK
          ? 0
          : value >= WHITE
            ? 255
            : Math.round(((value - BLACK) * 255) / (WHITE - BLACK));
    }
  }
  const side = Math.round(TILE_SIZE * GLYPH_SHARE);
  const scaled = await sharp(glyph, {
    raw: { width: cropWidth, height: cropHeight, channels: 4 },
  })
    .resize(side, side, { fit: 'inside' })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: TILE_SIZE,
      height: TILE_SIZE,
      channels: 3,
      background,
    },
  })
    .composite([{ input: scaled, gravity: 'centre' }])
    .png()
    .toBuffer();
}
