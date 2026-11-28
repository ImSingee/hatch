import { useQuery } from '@tanstack/react-query';
import { Pressable, ScrollView, View } from 'react-native';
import type { AppSummary } from '../core';
import { useBesideApp } from '../state/beside';
import { useSession } from '../state/session';
import { useBesideRoom } from './beside-layout';
import { IconButton } from './button';
import { Busy, Notice, errorText } from './primitives';
import { AppTile } from './rows';
import { SectionLabel, pageScrollProps } from './screen';
import { Text, useType } from './text';
import { useAccent, usePalette, useTheme } from './theme-context';

/**
 * The instance's Apps beside the one on screen, where the window has room
 * for both (`ListDetail`). A row shows its App in place of the current one;
 * a running App it replaces keeps running, as when leaving its page.
 */
export function AppSwitcher({
  current,
  onSelect,
  undeployed = false,
}: {
  /** The App on screen. */
  current: string | undefined;
  onSelect: (app: AppSummary) => void;
  /**
   * Also list Apps with nothing deployed yet. Running Apps leave them out:
   * they have nothing to show.
   */
  undeployed?: boolean;
}) {
  const { api, origin } = useSession();
  const c = usePalette();
  const accent = useAccent();
  const { radii } = useTheme();
  const type = useType();
  const room = useBesideRoom();
  const [, setBeside] = useBesideApp();
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
  const items = (apps.data ?? [])
    .filter((item) => (undeployed || item.live) && item.status !== 'archived')
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
              <View
                key={item.id}
                style={{ flexDirection: 'row', alignItems: 'center' }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={item.name}
                  accessibilityState={{ selected }}
                  onPress={() => {
                    if (!selected) onSelect(item);
                  }}
                  style={({ pressed }) => ({
                    flex: 1,
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
                {/* Where the window has room for two, a running App can sit
                  beside the screen in front (web Desk: "Open beside"). */}
                {room && item.live && !selected ? (
                  <IconButton
                    label={`Open ${item.name} beside`}
                    glyph="open"
                    tone="clear"
                    size={40}
                    onPress={() =>
                      setBeside({
                        id: item.id,
                        slug: item.slug,
                        name: item.name,
                        runtime: item.runtime,
                      })
                    }
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}
