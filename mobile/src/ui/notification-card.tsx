import { StyleSheet, View } from 'react-native';
import type { NotificationCard } from '../../../packages/hatch-platform-api/notification-card';
import { useAccent } from './accent';
import { Tag, type TagTone } from './primitives';
import { Text, type } from './text';
import { palette as c, pill, radii, status } from './theme';

const TAG_TONE: Record<string, TagTone> = {
  neutral: 'quiet',
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

/** The card's status: a tinted pill with a dot, its tone also in words. */
export function CardStatus({ card }: { card: NotificationCard }) {
  if (!card.status) return null;
  return (
    <Tag label={card.status.label} tone={TAG_TONE[card.status.tone]} dot />
  );
}

/** The card's one block: progress, up to three figures, or a quote. */
export function CardBlock({ card }: { card: NotificationCard }) {
  const accent = useAccent();
  const block = card.block;
  if (!block) return null;
  if (block.type === 'progress') {
    const tone = card.status?.tone;
    const fill =
      tone === 'info' ||
      tone === 'success' ||
      tone === 'warning' ||
      tone === 'danger'
        ? status[tone].fill
        : accent.fill;
    return (
      <View style={{ gap: 6 }}>
        <View style={styles.progressHead}>
          <Text style={[type.small, { flex: 1 }]}>{block.label}</Text>
          {block.value ? (
            <Text style={[type.mono, { color: c.ink }]}>{block.value}</Text>
          ) : null}
        </View>
        <View
          style={styles.track}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={block.label}
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(block.percent),
            text: block.value,
          }}
        >
          <View
            style={[
              styles.fill,
              { width: `${block.percent}%`, backgroundColor: fill },
            ]}
          />
        </View>
      </View>
    );
  }
  if (block.type === 'stats') {
    return (
      <View style={styles.stats}>
        {block.items.map((stat) => (
          <View key={`${stat.label}:${stat.value}`} style={styles.stat}>
            <Text style={type.title} numberOfLines={1} adjustsFontSizeToFit>
              {stat.value}
            </Text>
            <Text style={type.caption}>{stat.label}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={styles.quote}>
      <Text style={type.caption}>
        <Text style={[type.caption, { color: c.ink }]}>{block.author}</Text>
        {block.location ? `  ${block.location}` : ''}
      </Text>
      <Text style={[type.small, { color: c.ink }]}>{block.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  progressHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  track: {
    height: 6,
    borderRadius: pill,
    backgroundColor: c.hover,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: pill },
  stats: { flexDirection: 'row', gap: 8 },
  stat: {
    flex: 1,
    gap: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: c.muted,
  },
  quote: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.md,
    backgroundColor: c.muted,
  },
});
