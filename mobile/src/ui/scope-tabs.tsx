import { Pressable, View } from 'react-native';
import { Text, type } from './text';
import { palette as c, radii, shadows } from './theme';

/**
 * Desk segmented control: a sunken track with a white thumb under the
 * selected label. Segments share the width equally.
 */
export function ScopeTabs<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        marginHorizontal: 16,
        padding: 3,
        borderRadius: radii.md,
        backgroundColor: c.sunken,
      }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              option.count === undefined
                ? option.label
                : `${option.label}, ${option.count}`
            }
            onPress={() => onChange(option.value)}
            hitSlop={{ top: 5, bottom: 5 }}
            style={{
              flex: 1,
              minHeight: 34,
              paddingHorizontal: 8,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              borderRadius: radii.sm,
              backgroundColor: active ? c.card : 'transparent',
              boxShadow: active ? shadows.card : undefined,
            }}
          >
            <Text
              maxFontSizeMultiplier={1.4}
              numberOfLines={1}
              style={[
                type.small,
                { fontSize: 14, color: active ? c.ink : c.inkSoft },
                active && type.heading,
                active && { fontSize: 14 },
              ]}
            >
              {option.label}
            </Text>
            {option.count !== undefined ? (
              <Text maxFontSizeMultiplier={1.4} style={type.caption}>
                {option.count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
