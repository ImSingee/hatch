import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import {
  Children,
  Fragment,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSession } from '../state/session';
import { useAccent } from './accent';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { Text, type } from './text';
import { palette as c, radii, shadows, sizes, tileFor, weights } from './theme';

/** Tile radius by rendered size, on the token scale. */
function tileRadius(size: number) {
  return size <= 24
    ? radii.xs
    : size <= 38
      ? radii.sm
      : size <= 48
        ? radii.md
        : size <= 64
          ? radii.tile
          : radii.xl;
}

/** Workflows share the tile and differ by shape: one tight corner. */
function tileShape(size: number, workflow: boolean) {
  const radius = tileRadius(size);
  return workflow
    ? { borderRadius: radius, borderBottomLeftRadius: radius / 4 }
    : { borderRadius: radius };
}

/** The stored size that covers `size` points on a 3x display. */
function storedSize(size: number): 64 | 128 | 256 {
  return size <= 22 ? 64 : size <= 44 ? 128 : 256;
}

/**
 * An App's tile: its stored icon when it has one, otherwise the Desk
 * monogram, the first character of the name in white on a tile fill chosen by
 * a stable hash of `seed` (the App id). Same behaviour as the web `AppGlyph`.
 * Workflows have no icons: leave `iconPath` out and pass `workflow`.
 */
export function AppTile({
  name,
  seed,
  iconPath,
  size = 44,
  workflow = false,
  lifted = false,
}: {
  name: string;
  seed?: string;
  iconPath?: string | null;
  size?: number;
  workflow?: boolean;
  /** Home-screen tiles float on a shadow; tiles in a row stay flat. */
  lifted?: boolean;
}) {
  const { api, origin } = useSession();
  const stored = storedSize(size);
  const source = useQuery({
    queryKey: [origin, 'app-icon', iconPath, stored],
    queryFn: () => api!.appIconSource(iconPath!, stored),
    enabled: Boolean(api && iconPath),
    staleTime: Infinity,
    retry: false,
  });
  // The path can be stale (icon removed elsewhere since the list loaded):
  // remember the address that failed and show the monogram until it changes.
  const [failed, setFailed] = useState<string | null>(null);
  const shape = tileShape(size, workflow);
  const frame = {
    width: size,
    height: size,
    ...shape,
    ...(lifted ? { boxShadow: shadows.card } : null),
  };
  if (source.data && failed !== source.data.uri)
    return (
      <View accessible={false} style={frame}>
        <Image
          accessible={false}
          source={source.data}
          // Icons never reach the disk: this phone keeps instance data in
          // memory only.
          cachePolicy="memory"
          contentFit="cover"
          onError={() => setFailed(source.data!.uri)}
          style={{ width: size, height: size, ...shape }}
        />
      </View>
    );
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
  return (
    <View
      accessible={false}
      style={[
        frame,
        {
          backgroundColor: tileFor(seed ?? name),
          // Same top light as the web monogram and generated App icons.
          backgroundImage:
            'linear-gradient(rgba(255, 255, 255, 0.12), rgba(0, 0, 0, 0.18))',
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Text
        maxFontSizeMultiplier={1.2}
        style={{
          fontSize: size * 0.46,
          lineHeight: size * 0.6,
          fontWeight: weights.heading,
          color: c.onFill,
        }}
      >
        {letter}
      </Text>
    </View>
  );
}

export function GlyphTile({
  glyph,
  tone = 'muted',
  fill,
  size = 34,
  workflow = false,
}: {
  glyph: GlyphName;
  tone?: 'muted' | 'accent' | 'ink' | 'fill';
  /** A tile fill; the glyph turns white. Overrides `tone`. */
  fill?: string;
  size?: number;
  workflow?: boolean;
}) {
  const accent = useAccent();
  const colors = fill
    ? { bg: fill, fg: c.onFill }
    : {
        muted: { bg: c.muted, fg: c.ink },
        accent: { bg: accent.tint, fg: accent.ink },
        ink: { bg: c.ink, fg: c.card },
        fill: { bg: accent.fill, fg: accent.onFill },
      }[tone];
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        ...tileShape(size, workflow),
        backgroundColor: colors.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Glyph name={glyph} size={size * 0.48} color={colors.fg} />
    </View>
  );
}

/** A white sheet of rows separated by hairlines. */
export function Group({ children }: PropsWithChildren) {
  const items = Children.toArray(children).filter(Boolean);
  return (
    <View style={groupStyles.sheet}>
      <View style={groupStyles.clip}>
        {items.map((child, index) => (
          <Fragment key={index}>
            {index ? <View style={groupStyles.rule} /> : null}
            {child}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

export function ListRow({
  title,
  detail,
  leading,
  trailing,
  mark,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  title: string;
  detail?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** A small glyph after the title, e.g. the pin of a pinned App. */
  mark?: { glyph: GlyphName; label: string };
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        accessibilityLabel ??
        [title, mark?.label, detail].filter(Boolean).join(', ')
      }
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        rowStyles.row,
        pressed && { backgroundColor: c.hover },
      ]}
    >
      {leading}
      <View style={rowStyles.text}>
        <View style={rowStyles.title}>
          <Text style={[type.heading, { flexShrink: 1 }]} numberOfLines={2}>
            {title}
          </Text>
          {mark ? (
            <Glyph name={mark.glyph} size={11} color={c.inkSoft} />
          ) : null}
        </View>
        {detail ? (
          <Text style={type.small} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {trailing}
      <Glyph name="chevron" size={12} color={c.inkSoft} />
    </Pressable>
  );
}

/**
 * Sizes of a grid of shortcut tiles (Home's pins, every App in Apps): the
 * desk tile, and the narrowest column a tile and its label may take. Large
 * text needs wider columns for the one-line labels.
 */
export function useShortcutGrid() {
  const { fontScale } = useWindowDimensions();
  return {
    tile: sizes.deskTile,
    minTile: fontScale > 1.3 ? 104 : 76,
    gap: 8,
  };
}

/**
 * A shortcut tile over its one-line label, on Home and in Apps. A pin keeps
 * its own label and destination, even for the same App.
 */
export function ShortcutTile({
  label,
  accessibilityLabel,
  width,
  onPress,
  onLongPress,
  accessibilityHint,
  muted = false,
  children,
}: PropsWithChildren<{
  label: string;
  accessibilityLabel: string;
  width: number;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityHint?: string;
  /** A quieter label, for a tile that is an action and not a shortcut. */
  muted?: boolean;
}>) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        width,
        minHeight: 44,
        alignItems: 'center',
        gap: 7,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {children}
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}
        style={[
          type.caption,
          { color: muted ? c.inkSoft : c.ink, maxWidth: width },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The dashed "add" outline in the shape of the tiles beside it. */
export function AddTile({
  size = 44,
  workflow = false,
}: {
  size?: number;
  workflow?: boolean;
}) {
  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        ...tileShape(size, workflow),
        borderWidth: 1.5,
        borderStyle: 'dashed',
        borderColor: c.outline,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Glyph name="plus" size={size * 0.34} color={c.inkSoft} />
    </View>
  );
}

const groupStyles = StyleSheet.create({
  sheet: {
    backgroundColor: c.card,
    borderRadius: radii.lg,
    boxShadow: shadows.card,
  },
  clip: { borderRadius: radii.lg, overflow: 'hidden' },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.hairline,
    marginLeft: 16,
  },
});

const rowStyles = StyleSheet.create({
  row: {
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  text: { flex: 1, gap: 2 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
