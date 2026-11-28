import { useQuery } from '@tanstack/react-query';
import { Pressable, ScrollView, View } from 'react-native';
import type { AppSummary } from '../core';
import { useSession } from '../state/session';
import { Busy, Notice, errorText } from './primitives';
import { AppTile } from './rows';
import { SectionLabel, pageScrollProps } from './screen';
import { Text, useType } from './text';
import { useAccent, usePalette, useTheme } from './theme-context';

/**
 * The instance's Apps beside the one on screen, where the window has room
 * for both (`ListDetail`). A row shows its App in place of the current one;
 * the one it replaces keeps running, as when leaving its page. Apps that have
 * nothing deployed yet are left out: they have nothing to show.
 */
export function AppSwitcher({
  current,
  onSelect,
}: {
  /** The App on screen. */
  current: string | undefined;
  onSelect: (app: AppSummary) => void;
}) {
  const { api, origin } = useSession();
  const c = usePalette();
  const accent = useAccent();
  const { radii } = useTheme();
  const type = useType();
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
  const items = (apps.data ?? [])
    .filter((item) => item.live && item.status !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ScrollView
      {...pageScrollProps}
      accessibilityLabel="Apps"
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24 }}
    >
      <SectionLabel count={apps.data ? items.length : undefined}>
        Apps
      </SectionLabel>
      {apps.error && !apps.data ? (
        <Notice
          tone="danger"
          title="Couldn’t load apps"
          detail={errorText(apps.error)}
          action={{ label: 'Try again', onPress: () => void apps.refetch() }}
        />
      ) : apps.isPending ? (
        <Busy label="Gathering apps" />
      ) : (
        <View style={{ gap: 2 }}>
          {items.map((item) => {
            const selected = item.id === current;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityLabel={item.name}
                accessibilityState={{ selected }}
                onPress={() => {
                  if (!selected) onSelect(item);
                }}
                style={({ pressed }) => ({
                  minHeight: 52,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: radii.md,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  backgroundColor: selected
                    ? accent.tint
                    : pressed
                      ? c.hover
                      : 'transparent',
                })}
              >
                <AppTile
                  name={item.name}
                  seed={item.id}
                  iconPath={item.iconPath}
                  size={36}
                />
                <Text
                  numberOfLines={2}
                  style={[
                    type.heading,
                    { flex: 1 },
                    selected ? { color: accent.ink } : null,
                  ]}
                >
                  {item.name}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
