import { Pressable, View } from 'react-native';
import { useAccent, usePalette, useStatus, useTheme } from './theme-context';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { Text } from './text';
import { pill, weights } from './theme';

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'muted';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: 'large' | 'regular' | 'small';
  glyph?: GlyphName;
  /** Drawn after the label, such as the arrow of a link that leaves. */
  trailingGlyph?: GlyphName;
  disabled?: boolean;
  /** A chosen answer: drawn selected, also to assistive technology. */
  selected?: boolean;
  /** Cannot be pressed, but not dimmed: an answer already given. */
  readOnly?: boolean;
  busy?: boolean;
  fullWidth?: boolean;
  /** Keep the label on one line, cut off where the button runs out of room. */
  singleLine?: boolean;
  accessibilityHint?: string;
};

// Desk buttons: the accent fill for the one primary action of a view, a card
// sheet with a hairline for the rest, a wash for subtle ones.
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'regular',
  glyph,
  trailingGlyph,
  disabled,
  selected,
  readOnly,
  busy,
  fullWidth,
  singleLine,
  accessibilityHint,
}: ButtonProps) {
  const accent = useAccent();
  const c = usePalette();
  const status = useStatus();
  const { radii } = useTheme();
  const tone = {
    primary: {
      bg: accent.fill,
      down: accent.pressed,
      fg: accent.onFill,
      border: 'transparent',
    },
    secondary: { bg: c.card, down: c.muted, fg: c.ink, border: c.hairline },
    quiet: {
      bg: 'transparent',
      down: c.pressed,
      fg: accent.ink,
      border: 'transparent',
    },
    danger: {
      bg: status.danger.tint,
      down: status.danger.tintStrong,
      fg: status.danger.ink,
      border: 'transparent',
    },
    // A link among answers: grey, never mistaken for one.
    muted: { bg: c.muted, down: c.pressed, fg: c.ink, border: 'transparent' },
  }[variant];
  const unavailable = Boolean(disabled || busy || readOnly);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{
        disabled: unavailable,
        busy: Boolean(busy),
        ...(selected === undefined ? {} : { selected }),
      }}
      disabled={unavailable}
      onPress={onPress}
      hitSlop={size === 'small' ? 5 : 4}
      style={({ pressed }) => ({
        minHeight: size === 'large' ? 50 : size === 'small' ? 36 : 44,
        paddingHorizontal:
          variant === 'quiet' ? 10 : size === 'small' ? 14 : 20,
        paddingVertical: size === 'small' ? 6 : 10,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: pressed ? tone.down : tone.bg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
        opacity: unavailable && !readOnly ? 0.5 : 1,
      })}
    >
      {glyph ? (
        <Glyph name={glyph} size={size === 'small' ? 12 : 15} color={tone.fg} />
      ) : null}
      <Text
        numberOfLines={singleLine ? 1 : undefined}
        style={{
          color: tone.fg,
          fontSize: size === 'large' ? 17 : size === 'small' ? 14 : 16,
          fontWeight: size === 'large' ? weights.heading : weights.label,
          textAlign: 'center',
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      {trailingGlyph ? (
        <Glyph
          name={trailingGlyph}
          size={size === 'small' ? 11 : 13}
          color={tone.fg}
        />
      ) : null}
    </Pressable>
  );
}

/** A round control for toolbar-style actions, at least 44 points to touch. */
export function IconButton({
  label,
  glyph,
  onPress,
  tone = 'card',
  disabled,
  size = 44,
}: {
  label: string;
  glyph: GlyphName;
  onPress: () => void;
  tone?: 'card' | 'accent' | 'ink' | 'clear' | 'tint' | 'sunken';
  disabled?: boolean;
  size?: number;
}) {
  const accent = useAccent();
  const c = usePalette();
  const colors = {
    card: { bg: c.card, fg: c.ink },
    accent: { bg: accent.fill, fg: accent.onFill },
    ink: { bg: c.ink, fg: c.card },
    clear: { bg: 'transparent', fg: c.inkSoft },
    tint: { bg: accent.tint, fg: accent.ink },
    sunken: { bg: c.sunken, fg: c.inkSoft },
  }[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: Math.max(size, 44),
        height: Math.max(size, 44),
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: pill,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Glyph name={glyph} size={Math.round(size * 0.38)} color={colors.fg} />
      </View>
    </Pressable>
  );
}
