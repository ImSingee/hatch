import {
  StyleSheet,
  Text as NativeText,
  type TextProps,
  useWindowDimensions,
} from 'react-native';
import { fonts, palette as c, weights } from './theme';

// Every text in the app is Nunito at the body weight unless a style says
// otherwise. The key refreshes native text layout on Dynamic Type changes
// without resetting screen state.
export function Text({ style, ...props }: TextProps) {
  const { fontScale } = useWindowDimensions();
  return <NativeText key={fontScale} {...props} style={[base.text, style]} />;
}

const base = StyleSheet.create({
  text: { fontFamily: fonts.sans, fontWeight: weights.body, color: c.ink },
});

/**
 * The Desk type scale at native sizes. Weight carries the hierarchy: heavy
 * headings and labels, medium body, nothing below 500.
 */
export const type = StyleSheet.create({
  display: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: weights.heading,
    letterSpacing: -0.34,
    color: c.ink,
  },
  title: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: weights.heading,
    letterSpacing: -0.22,
    color: c.ink,
  },
  heading: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: weights.label,
    color: c.ink,
  },
  body: { fontSize: 16, lineHeight: 23, color: c.ink },
  callout: { fontSize: 15, lineHeight: 21, color: c.inkSoft },
  small: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weights.strong,
    color: c.inkSoft,
  },
  /** Timestamps, counts and other one-line facts. */
  caption: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: weights.label,
    color: c.inkSoft,
  },
  /** Group label above a list or a grid. */
  meta: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: weights.heading,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    color: c.inkSoft,
  },
  /** Code, identifiers and values a person may copy. */
  mono: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: weights.body,
    color: c.inkSoft,
  },
});
