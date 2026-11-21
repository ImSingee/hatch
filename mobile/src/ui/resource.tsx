import { StyleSheet, View } from 'react-native';
import { AppTile } from './rows';
import { StatusTag } from './status';
import { Tag } from './primitives';
import { Text, type } from './text';
import { palette as c, radii, shadows } from './theme';

/** Identity of an App or Workflow at the top of its page. */
export function ResourceHeader({
  name,
  seed,
  iconPath,
  workflow = false,
  description,
  status,
  pinned = false,
}: {
  name: string;
  seed: string;
  iconPath?: string | null;
  workflow?: boolean;
  description: string;
  status: string;
  pinned?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <AppTile
        name={name}
        seed={seed}
        iconPath={iconPath}
        workflow={workflow}
        size={72}
        lifted
      />
      <View style={{ flex: 1, gap: 6 }}>
        <Text
          accessibilityRole="header"
          maxFontSizeMultiplier={1.6}
          numberOfLines={3}
          style={[type.title, { fontSize: 28, lineHeight: 34 }]}
        >
          {name}
        </Text>
        <Text style={type.small} numberOfLines={3}>
          {description}
        </Text>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          <StatusTag status={status} />
          {pinned ? <Tag tone="outline" glyph="pin" label="Pinned" /> : null}
        </View>
      </View>
    </View>
  );
}

/** Label and value pairs on one sheet, separated by hairlines. */
export function Facts({ items }: { items: [label: string, value: string][] }) {
  return (
    <View style={styles.sheet}>
      {items.map(([label, value], index) => (
        <View
          key={label}
          accessible
          accessibilityLabel={`${label}: ${value}`}
          style={[styles.fact, index > 0 && styles.rule]}
        >
          <Text style={type.small}>{label}</Text>
          <Text
            selectable
            style={[type.callout, { color: c.ink, flexShrink: 1 }]}
          >
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: c.card,
    borderRadius: radii.lg,
    boxShadow: shadows.card,
    paddingHorizontal: 16,
  },
  fact: {
    minHeight: 48,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 10,
  },
  rule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
  },
});
