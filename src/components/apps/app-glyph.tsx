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
  /** `dock` is the dock tile: the size comes from the design tokens. */
  size?: 'sm' | 'md' | 'dock' | 'lg';
};

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
  const src = appIconUrl(props.seed, key, size === 'sm' ? 64 : 128);
  if (failed === src) return <Monogram {...props} />;
  return (
    <img
      className={classes.glyph}
      data-size={size}
      src={src}
      onError={() => setFailed(src)}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}

function Monogram({ name, seed, size = 'md' }: GlyphProps) {
  const tile = TILE_COLORS[hash(seed ?? name) % TILE_COLORS.length];
  return (
    <span
      className={classes.glyph}
      data-size={size}
      aria-hidden
      style={{ '--glyph-bg': tile } as CSSProperties}
    >
      {initialOf(name)}
    </span>
  );
}
