import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useNavigationPreferences } from '../src/state/navigation';
import {
  defaultNavigation,
  type TabId,
} from '../src/core/navigation-preferences';
import { Button } from '../src/ui/button';
import { Glyph } from '../src/ui/glyph';
import type { GlyphName } from '../src/ui/glyph.types';
import { Card, Notice } from '../src/ui/primitives';
import { GlyphTile } from '../src/ui/rows';
import {
  Masthead,
  SectionLabel,
  pageScrollProps,
  readable,
} from '../src/ui/screen';
import { Text, type } from '../src/ui/text';
import { useAccent } from '../src/ui/accent';
import { meTab, tabDetails } from '../src/ui/navigation';
import { palette as c, pill, radii, shadows, weights } from '../src/ui/theme';

type Start = TabId | 'more';

export default function NavigationSettings() {
  const { preferences: p, save, saving, error } = useNavigationPreferences();
  const accent = useAccent();
  const move = (id: TabId, offset: number) => {
    const order = [...p.order];
    const from = order.indexOf(id);
    const to = from + offset;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    void save({ ...p, order });
  };
  const shown = p.order.filter((id) => p.visible.includes(id));
  const starts: { id: Start; label: string; glyph: GlyphName }[] = [
    ...shown.map((id) => ({
      id,
      label: tabDetails[id].label,
      glyph: tabDetails[id].glyph,
    })),
    { id: 'more', label: meTab.label, glyph: meTab.glyph },
  ];
  return (
    <ScrollView
      {...pageScrollProps}
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{ ...readable, paddingBottom: 32 }}
    >
      <Masthead
        nested
        eyebrow="Saved on this phone only"
        title="Tabs & start page"
      />
      <View style={{ paddingHorizontal: 16 }}>
        {error ? (
          <Notice tone="danger" title={error.title} detail={error.detail} />
        ) : null}
        <SectionLabel>Preview</SectionLabel>
        <View
          accessible
          accessibilityLabel={`Tab bar: ${starts.map((s) => s.label).join(', ')}`}
          style={{
            flexDirection: 'row',
            backgroundColor: c.dock,
            borderRadius: radii.dock,
            boxShadow: shadows.dock,
            padding: 6,
            gap: 2,
          }}
        >
          {starts.map((item) => {
            const isStart = item.id === p.defaultTab;
            return (
              <View
                key={item.id}
                style={{
                  flex: 1,
                  alignItems: 'center',
                  gap: 3,
                  paddingVertical: 8,
                  borderRadius: pill,
                  backgroundColor: isStart ? c.hover : 'transparent',
                }}
              >
                <Glyph
                  name={item.glyph}
                  size={18}
                  color={isStart ? accent.fill : c.inkSoft}
                />
                <Text
                  maxFontSizeMultiplier={1.3}
                  numberOfLines={1}
                  style={[
                    type.small,
                    {
                      fontSize: 11,
                      lineHeight: 14,
                      fontWeight: isStart ? weights.label : weights.strong,
                      color: isStart ? accent.fill : c.inkSoft,
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </View>
            );
          })}
        </View>

        <SectionLabel>Open Hatch to</SectionLabel>
        <View
          accessibilityRole="radiogroup"
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
        >
          {starts.map((item) => {
            const selected = item.id === p.defaultTab;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: saving }}
                disabled={saving}
                onPress={() => void save({ ...p, defaultTab: item.id })}
                style={({ pressed }) => ({
                  minHeight: 44,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 16,
                  borderRadius: radii.md,
                  backgroundColor: selected ? accent.fill : c.card,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                {selected ? (
                  <Glyph name="check" size={12} color={accent.onFill} />
                ) : null}
                <Text
                  style={[
                    type.heading,
                    { fontSize: 15, color: selected ? accent.onFill : c.ink },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <SectionLabel count={shown.length}>In the tab bar</SectionLabel>
        <View
          style={{
            backgroundColor: c.card,
            borderRadius: radii.lg,
            boxShadow: shadows.card,
          }}
        >
          {p.order.map((id, index) => {
            const visible = p.visible.includes(id);
            const label = tabDetails[id].label;
            return (
              <View
                key={id}
                style={{
                  padding: 14,
                  gap: 10,
                  borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                  borderTopColor: c.hairline,
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <GlyphTile
                    glyph={tabDetails[id].glyph}
                    tone={visible ? 'accent' : 'muted'}
                  />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={type.heading}>{label}</Text>
                    <Text style={type.small}>
                      {visible
                        ? 'Shown as a tab'
                        : `Hidden · still in ${meTab.label}`}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={`Show ${label} in the tab bar`}
                    value={visible}
                    disabled={saving}
                    trackColor={{ true: accent.fill, false: c.idle }}
                    thumbColor={c.card}
                    ios_backgroundColor={c.idle}
                    onValueChange={() =>
                      void save({
                        ...p,
                        visible: visible
                          ? p.visible.filter((tab) => tab !== id)
                          : [...p.visible, id],
                      })
                    }
                  />
                </View>
                <View
                  style={{
                    flexDirection: 'row',
                    gap: 8,
                    paddingLeft: 46,
                    flexWrap: 'wrap',
                  }}
                >
                  <Button
                    variant="secondary"
                    size="small"
                    glyph="up"
                    label="Move up"
                    accessibilityHint={`Moves ${label} earlier`}
                    disabled={saving || index === 0}
                    onPress={() => move(id, -1)}
                  />
                  <Button
                    variant="secondary"
                    size="small"
                    glyph="down"
                    label="Move down"
                    accessibilityHint={`Moves ${label} later`}
                    disabled={saving || index === p.order.length - 1}
                    onPress={() => move(id, 1)}
                  />
                </View>
              </View>
            );
          })}
        </View>

        <Card style={{ marginTop: 20 }}>
          <Text style={type.heading}>{meTab.label} always comes last</Text>
          <Text style={type.callout}>
            Hidden tabs stay one tap away in {meTab.label}. If you hide your
            start page, Hatch opens the first visible tab instead.
          </Text>
        </Card>
        <View style={{ marginTop: 16 }}>
          <Button
            variant="quiet"
            glyph="refresh"
            label="Restore default tabs"
            disabled={saving}
            onPress={() => void save(defaultNavigation)}
          />
        </View>
      </View>
    </ScrollView>
  );
}
