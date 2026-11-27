import {
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useWindowDimensions,
} from 'react-native';
import { themedStyles } from './theme-context';
import { weights, type MobileTheme } from './theme';

// Every text in the app is in the theme's sans face at the body weight unless
// a style says otherwise. The key refreshes native text layout on Dynamic Type
// changes without resetting screen state.
export function Text({ style, ...props }: TextProps) {
  const { fontScale } = useWindowDimensions();
  const base = useBase();
  return <NativeText key={fontScale} {...props} style={[base.text, style]} />;
}

const useBase = themedStyles((t) =>
  StyleSheet.create({
    text: {
      fontFamily: t.fonts.sans,
      fontWeight: weights.body,
      color: t.palette.ink,
    },
  }),
);

/**
 * The Desk type scale at native sizes. Weight carries the hierarchy: heavy
 * headings and labels, medium body, nothing below 500. Components read it
 * with `useType()`; other themed styles that build on it call `typeScale`.
 */
export function typeScale(t: MobileTheme) {
  return StyleSheet.create({
    display: {
      fontSize: 34,
      lineHeight: 41,
      fontWeight: weights.heading,
      letterSpacing: -0.34,
      color: t.palette.ink,
    },
    title: {
      fontSize: 22,
      lineHeight: 28,
      fontWeight: weights.heading,
      letterSpacing: -0.22,
      color: t.palette.ink,
    },
    heading: {
      fontSize: 17,
      lineHeight: 22,
      fontWeight: weights.label,
      color: t.palette.ink,
    },
    body: { fontSize: 16, lineHeight: 23, color: t.palette.ink },
    callout: { fontSize: 15, lineHeight: 21, color: t.palette.inkSoft },
    small: {
      fontSize: 13,
      lineHeight: 18,
      fontWeight: weights.strong,
      color: t.palette.inkSoft,
    },
    /** Timestamps, counts and other one-line facts. */
    caption: {
      fontSize: 12,
      lineHeight: 16,
      fontWeight: weights.label,
      color: t.palette.inkSoft,
    },
    /** Group label above a list or a grid. */
    meta: {
      fontSize: 13,
      lineHeight: 18,
      fontWeight: weights.heading,
      letterSpacing: 0.9,
      textTransform: 'uppercase',
      color: t.palette.inkSoft,
    },
    /** Code, identifiers and values a person may copy. */
    mono: {
      fontFamily: t.fonts.mono,
      fontSize: 12,
      lineHeight: 18,
      fontWeight: weights.body,
      color: t.palette.inkSoft,
    },
  });
}

export const useType = themedStyles(typeScale);
