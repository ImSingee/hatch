import { type CSSProperties, useState } from 'react';
import { TILE_COLORS } from '~/ui/theme';
import classes from './app-glyph.module.css';
import { appIconUrl, useAppIconKey, useHasAppIcons } from './use-app-icon';

/**
 * A small rounded monogram tile for an app, giving each app a stable visual
 * identity in lists and the sidebar. The tint is derived deterministically from
 * a stable seed (the app id) so it never shifts when an app is renamed, and it
 * is one of the design tokens' tile fills, which all carry white text.
 */

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}

type GlyphProps = {
  name: string;
  /** Stable identifier for the tint; defaults to the name. */
  seed?: string;
  /**
   * `widget` (26) heads a widget panel, `dock` (40) is the dock tile and
   * `desk` (60) the desk home tile; those three sizes come from the design
   * tokens. `xl` (56) is the launcher tile and `hero` (72) leads a detail view.
   */
  size?: 'sm' | 'widget' | 'md' | 'dock' | 'lg' | 'xl' | 'desk' | 'hero';
  /** Workflows share the tile and differ by one squared-off corner. */
  shape?: 'app' | 'workflow';
};

/** Stored icon size that covers a tile on a 2x display. */
function iconSizeFor(size: NonNullable<GlyphProps['size']>): 64 | 128 | 256 {
  if (size === 'sm') return 64;
  return size === 'xl' || size === 'desk' || size === 'hero' ? 256 : 128;
}

/**
 * An App's tile: its stored icon when it has one, else the monogram. `seed`
 * is looked up as an App id; pass `icon={false}` for anything that is not an
 * App (Workflows share this tile but have no icons).
 */
export function AppGlyph({
  icon = true,
  ...props
}: GlyphProps & { icon?: boolean }) {
  const available = useHasAppIcons();
  return icon && available && props.seed ? (
    <AppIconGlyph {...props} />
  ) : (
    <Monogram {...props} />
  );
}

function AppIconGlyph(props: GlyphProps) {
  const key = useAppIconKey(props.seed);
  const size = props.size ?? 'md';
  // The key can be stale (icon removed elsewhere since the index loaded):
  // remember the URL that failed and show the monogram until it changes.
  const [failed, setFailed] = useState<string | null>(null);
  if (!key || !props.seed) return <Monogram {...props} />;
  const src = appIconUrl(props.seed, key, iconSizeFor(size));
  if (failed === src) return <Monogram {...props} />;
  return (
    <img
      className={classes.glyph}
      data-size={size}
      data-shape={props.shape}
      src={src}
      onError={() => setFailed(src)}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}

function Monogram({ name, seed, size = 'md', shape }: GlyphProps) {
  const tile = TILE_COLORS[hash(seed ?? name) % TILE_COLORS.length];
  return (
    <span
      className={classes.glyph}
      data-size={size}
      data-shape={shape}
      aria-hidden
      style={{ '--glyph-bg': tile } as CSSProperties}
    >
      {initialOf(name)}
    </span>
  );
}
