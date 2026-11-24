/**
 * Server-only: turn a model's drawing into an App icon tile.
 *
 * Image models are good at one bold subject but drift on background colour
 * and margins. The platform therefore owns both: the subject is cut out,
 * scaled to a fixed share of the tile and laid on a ground derived from one
 * palette colour: a soft vertical gradient with a top highlight. Corners
 * stay square; the UI rounds them.
 *
 * - `composeSubjectTile`: a full-colour subject on a transparent background
 *   (the Glossy and Glass icon styles), with a contact shadow under it.
 * - `composeGlyphTile`: a white glyph drawn on black (the Line icon style),
 *   whose luminance becomes opacity.
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

/** Share of the tile's side taken by a subject's longer side. */
const SUBJECT_SHARE = 0.72;
/** Alpha at or below this is background; at or above OPAQUE is solid. */
const CLEAR = 8;
const OPAQUE = 240;
/** A cut-out leaves at least this share of the canvas transparent. */
const MIN_CLEAR_SHARE = 0.15;
/** A subject covers at least this share of the canvas. */
const MIN_SUBJECT_SHARE = 0.01;

/** Mix `hex` toward white (positive `amount`) or black (negative). */
function shade(hex: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  const weight = Math.abs(amount);
  return `#${[1, 3, 5]
    .map((start) => {
      const value = Number.parseInt(hex.slice(start, start + 2), 16);
      return Math.round(value + (target - value) * weight)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/** The tile ground: a vertical gradient of `color` with a top highlight. */
function tileGround(color: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_SIZE}" height="${TILE_SIZE}">` +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      `<stop offset="0" stop-color="${shade(color, 0.22)}"/>` +
      `<stop offset="1" stop-color="${shade(color, -0.14)}"/>` +
      '</linearGradient><radialGradient id="h" cx="0.5" cy="0" r="0.75">' +
      '<stop offset="0" stop-color="#fff" stop-opacity="0.22"/>' +
      '<stop offset="1" stop-color="#fff" stop-opacity="0"/>' +
      '</radialGradient></defs>' +
      `<rect width="${TILE_SIZE}" height="${TILE_SIZE}" fill="url(#g)"/>` +
      `<rect width="${TILE_SIZE}" height="${TILE_SIZE}" fill="url(#h)"/></svg>`,
  );
}

export async function composeSubjectTile(
  drawing: Buffer,
  color: string,
): Promise<Buffer> {
  if (!isTileColor(color))
    throw new AppError('Tile colour must be a #RRGGBB colour.', 400);
  const { data, info } = await sharp(drawing, { limitInputPixels: 4096 * 4096 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let clear = 0;
  let solid = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4 + 3;
      const alpha = data[index];
      // Models rarely reach full opacity (253 is common): stretch the range
      // so the subject is solid and the tile does not show through it.
      const value =
        alpha <= CLEAR
          ? 0
          : alpha >= OPAQUE
            ? 255
            : Math.round(((alpha - CLEAR) * 255) / (OPAQUE - CLEAR));
      data[index] = value;
      if (value === 0) {
        clear += 1;
        continue;
      }
      if (value < 64) continue;
      solid += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const pixels = width * height;
  // An opaque picture (the model ignored the transparent background) or an
  // empty one is not a cut-out subject.
  if (clear < pixels * MIN_CLEAR_SHARE || solid < pixels * MIN_SUBJECT_SHARE)
    throw new AppError(
      'The image is not a subject on a transparent background.',
      400,
    );

  const side = Math.round(TILE_SIZE * SUBJECT_SHARE);
  const subject = await sharp(data, { raw: { width, height, channels: 4 } })
    .extract({
      left,
      top,
      width: right - left + 1,
      height: bottom - top + 1,
    })
    .resize(side, side, { fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true });
  const x = Math.round((TILE_SIZE - subject.info.width) / 2);
  const y = Math.round((TILE_SIZE - subject.info.height) / 2);

  // A soft contact shadow in a deep tone of the tile colour lifts the
  // subject off the ground, so a subject close to the tile colour still
  // reads at small sizes.
  const pad = 48;
  const shadowAlpha = await sharp(subject.data)
    .extractChannel(3)
    .linear(0.35, 0)
    .toBuffer();
  const shadow = await sharp({
    create: {
      width: subject.info.width,
      height: subject.info.height,
      channels: 3,
      background: shade(color, -0.6),
    },
  })
    .joinChannel(shadowAlpha)
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .blur(12)
    .png()
    .toBuffer();

  const tile = await sharp(tileGround(color))
    .composite([
      {
        input: shadow,
        left: x - pad,
        top: y - pad + Math.round(TILE_SIZE * 0.025),
      },
      { input: subject.data, left: x, top: y },
    ])
    .png()
    .toBuffer();
  // Compositing runs last in a pipeline, so drop the ground's alpha here.
  return sharp(tile).removeAlpha().png().toBuffer();
}

export async function composeGlyphTile(
  drawing: Buffer,
  background: string,
): Promise<Buffer> {
  if (!isTileColor(background))
    throw new AppError('Tile colour must be a #RRGGBB colour.', 400);
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
  const tile = await sharp(tileGround(background))
    .composite([{ input: scaled, gravity: 'centre' }])
    .png()
    .toBuffer();
  return sharp(tile).removeAlpha().png().toBuffer();
}
