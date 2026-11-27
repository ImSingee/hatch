import { useEffect, useState, type PropsWithChildren } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  View,
} from 'react-native';
import { Button } from './button';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { Text, typeScale } from './text';
import {
  themedStyles,
  useAccent,
  usePalette,
  useStatus,
} from './theme-context';
import { pill, weights } from './theme';

export { Text } from './text';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => alive && setReduced(value),
    );
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced,
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** The Hatch mark: an egg in the accent. `wobble` gives loaders a rock. */
export function Egg({
  size = 22,
  color,
  wobble = false,
}: {
  size?: number;
  color?: string;
  wobble?: boolean;
}) {
  const accent = useAccent();
  const reduced = useReducedMotion();
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (!wobble || reduced) return;
    const swing = (to: number, duration: number) =>
      Animated.timing(turn, {
        toValue: to,
        duration,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      });
    const loop = Animated.loop(
      Animated.sequence([
        swing(1, 220),
        swing(-1, 320),
        swing(0.5, 240),
        swing(0, 200),
        Animated.delay(520),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [wobble, reduced, turn]);
  const height = Math.round(size * 1.27);
  return (
    <Animated.View
      accessible={false}
      style={{
        width: size,
        height,
        alignItems: 'center',
        justifyContent: 'center',
        transform: [
          { translateY: height / 2 },
          {
            rotate: turn.interpolate({
              inputRange: [-1, 1],
              outputRange: ['-11deg', '11deg'],
            }),
          },
          { translateY: -height / 2 },
        ],
      }}
    >
      {/* An ellipse drawn at its own size: a stretched circle blurs its
          outline. */}
      <View
        style={{
          width: size,
          height,
          borderRadius: '50%',
          backgroundColor: color ?? accent.fill,
        }}
      />
    </Animated.View>
  );
}

export function Wordmark({ size = 30 }: { size?: number }) {
  const c = usePalette();
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel="Hatch"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <Egg size={size * 0.72} />
      <Text
        maxFontSizeMultiplier={1.4}
        style={{
          fontWeight: weights.heading,
          fontSize: size,
          letterSpacing: -size * 0.02,
          color: c.ink,
        }}
      >
        hatch
      </Text>
    </View>
  );
}

export type TagTone =
  | 'accent'
  | 'fill'
  | 'quiet'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'working'
  | 'outline';

/** Status chip: a pill in sentence case, tinted, with an optional dot. */
export function Tag({
  label,
  tone = 'quiet',
  glyph,
  dot = false,
}: {
  label: string;
  tone?: TagTone;
  glyph?: GlyphName;
  dot?: boolean;
}) {
  const accent = useAccent();
  const c = usePalette();
  const status = useStatus();
  const styles = useStyles();
  const tint = (ramp: { tint: string; ink: string; fill: string }) => ({
    bg: ramp.tint,
    fg: ramp.ink,
    mark: ramp.fill,
    border: ramp.tint,
  });
  const tones = {
    accent: tint(accent),
    fill: {
      bg: accent.fill,
      fg: accent.onFill,
      mark: accent.onFill,
      border: accent.fill,
    },
    quiet: { bg: c.hover, fg: c.inkSoft, mark: c.inkSoft, border: c.hover },
    info: tint(status.info),
    success: tint(status.success),
    warning: tint(status.warning),
    danger: tint(status.danger),
    working: tint(status.working),
    outline: {
      bg: 'transparent',
      fg: c.inkSoft,
      mark: c.inkSoft,
      border: c.hairline,
    },
  }[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        minHeight: 24,
        paddingHorizontal: 10,
        paddingVertical: 3,
        borderRadius: pill,
        borderWidth: tone === 'outline' ? 1 : 0,
        borderColor: tones.border,
        backgroundColor: tones.bg,
      }}
    >
      {dot ? (
        <View
          style={{
            width: 7,
            height: 7,
            borderRadius: pill,
            backgroundColor: tones.mark,
          }}
        />
      ) : null}
      {glyph ? <Glyph name={glyph} size={10} color={tones.fg} /> : null}
      <Text
        maxFontSizeMultiplier={1.6}
        style={[styles.caption, { color: tones.fg }]}
      >
        {label}
      </Text>
    </View>
  );
}

/** A card sheet floating on the ground. Never nest one in another. */
export function Card({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const styles = useStyles();
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Notice({
  title,
  detail,
  action,
  tone = 'neutral',
}: {
  title: string;
  detail?: string;
  action?: { label: string; onPress: () => void };
  tone?: 'neutral' | 'danger' | 'info';
}) {
  const accent = useAccent();
  const c = usePalette();
  const status = useStatus();
  const styles = useStyles();
  const mark =
    tone === 'danger'
      ? { bg: status.danger.tint, fg: status.danger.ink }
      : tone === 'info'
        ? { bg: accent.tint, fg: accent.ink }
        : { bg: c.muted, fg: c.ink };
  return (
    <Card>
      <View style={styles.row}>
        <View style={[styles.noticeMark, { backgroundColor: mark.bg }]}>
          <Glyph
            name={tone === 'info' ? 'sparkle' : 'warning'}
            size={15}
            color={mark.fg}
          />
        </View>
        <Text accessibilityRole="header" style={[styles.heading, styles.grow]}>
          {title}
        </Text>
      </View>
      {detail ? (
        <Text selectable style={styles.callout}>
          {detail}
        </Text>
      ) : null}
      {action ? (
        <Button
          variant="secondary"
          label={action.label}
          onPress={action.onPress}
          fullWidth
        />
      ) : null}
    </Card>
  );
}

export function Busy({ label = 'Loading…' }: { label?: string }) {
  const styles = useStyles();
  return (
    <View
      style={styles.busy}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
    >
      <Egg size={26} wobble />
      <Text style={styles.small}>{label}</Text>
    </View>
  );
}

/** Centred column: a tile, a heavy title, one or two muted sentences. */
export function EmptyState({
  title,
  detail,
  action,
  glyph = 'sparkle',
}: {
  title: string;
  detail: string;
  action?: { label: string; onPress: () => void };
  glyph?: GlyphName;
}) {
  const accent = useAccent();
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyMark, { backgroundColor: accent.tint }]}>
        <Glyph name={glyph} size={24} color={accent.ink} />
      </View>
      <Text
        accessibilityRole="header"
        style={[styles.title, { textAlign: 'center' }]}
      >
        {title}
      </Text>
      <Text style={[styles.callout, { maxWidth: 320, textAlign: 'center' }]}>
        {detail}
      </Text>
      {action ? (
        <Button
          variant="secondary"
          label={action.label}
          onPress={action.onPress}
        />
      ) : null}
    </View>
  );
}

export function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Try again.';
}

const useStyles = themedStyles((t) =>
  StyleSheet.create({
    grow: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    ...typeScale(t),
    card: {
      backgroundColor: t.palette.card,
      borderRadius: t.radii.xl,
      padding: 18,
      gap: 12,
      boxShadow: t.shadows.card,
    },
    noticeMark: {
      width: 34,
      height: 34,
      borderRadius: t.radii.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    busy: {
      flex: 1,
      minHeight: 160,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
    },
    empty: {
      alignItems: 'center',
      alignSelf: 'center',
      maxWidth: 420,
      gap: 12,
      paddingVertical: 36,
    },
    emptyMark: {
      width: 56,
      height: 56,
      borderRadius: t.radii.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
  }),
);
