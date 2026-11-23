import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Glyph } from './glyph';
import type { DetailProps } from './native-controls.types';
import { Text, type } from './text';
import { useAccent } from './accent';
import { palette as c, pill, radii, status as hue, weights } from './theme';

/** Collapsed tool, request and reasoning detail. Expands into a mono slip. */
export function Details({
  title,
  text,
  error,
  state,
}: DetailProps & { state?: 'working' | 'done' | 'failed' }) {
  const accent = useAccent();
  const [expanded, setExpanded] = useState(false);
  const failed = state === 'failed' || error;
  // The dot's color is not announced, so screen readers hear the status too.
  const status =
    state === 'working'
      ? 'In progress'
      : failed
        ? 'Failed'
        : state === 'done'
          ? 'Done'
          : undefined;
  const dot =
    state === 'working'
      ? accent.fill
      : failed
        ? hue.danger.fill
        : state === 'done'
          ? hue.success.fill
          : c.idle;
  return (
    <View
      style={{
        borderRadius: radii.lg,
        backgroundColor: c.card,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={title}
        accessibilityValue={status ? { text: status } : undefined}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: pressed ? c.hover : 'transparent',
        })}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: pill,
            backgroundColor: dot,
          }}
        />
        <Text
          style={[
            type.small,
            { flex: 1, color: c.ink, fontWeight: weights.label },
          ]}
          numberOfLines={2}
        >
          {title}
        </Text>
        <View style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}>
          <Glyph name="chevron" size={11} color={c.inkSoft} />
        </View>
      </Pressable>
      {expanded ? (
        <View
          style={{
            margin: 8,
            marginTop: 0,
            padding: 12,
            borderRadius: radii.sm,
            backgroundColor: c.muted,
          }}
        >
          <Text
            selectable
            style={[type.mono, error && { color: hue.danger.ink }]}
          >
            {text || 'No output.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
