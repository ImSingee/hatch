import { NativeTabs } from 'expo-router/native-tabs';
import { Platform } from 'react-native';
import { useNavigationPreferences } from '../../src/state/navigation';
import { useAccent } from '../../src/ui/accent';
import { meTab, tabDetails } from '../../src/ui/navigation';
import { palette as c, weights } from '../../src/ui/theme';

// The system tab bar: Home, Apps, Agent and Me by default. Which sections sit
// in it, and in what order, stays the user's choice (Tabs & start page).
export default function TabLayout() {
  const { preferences } = useNavigationPreferences();
  const accent = useAccent();
  return (
    <NativeTabs
      tintColor={accent.fill}
      iconColor={{ default: c.inkSoft, selected: accent.fill }}
      labelStyle={{
        default: { fontWeight: weights.strong, color: c.inkSoft },
        selected: { fontWeight: weights.label, color: accent.fill },
      }}
      minimizeBehavior="onScrollDown"
      // iOS keeps the system's glass bar. Android's navigation bar is drawn
      // from the tokens: a sunken bar, an accent-tint pill under the open tab.
      {...(Platform.OS === 'android'
        ? {
            backgroundColor: c.sunken,
            indicatorColor: accent.tint,
            rippleColor: c.pressed,
            labelVisibilityMode: 'labeled' as const,
          }
        : null)}
    >
      {preferences.order.map((id) => (
        <NativeTabs.Trigger
          key={id}
          name={id}
          hidden={!preferences.visible.includes(id)}
          contentStyle={{ backgroundColor: c.ground }}
        >
          <NativeTabs.Trigger.Label>
            {tabDetails[id].label}
          </NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={tabDetails[id].icon}
            md={tabDetails[id].androidIcon}
          />
        </NativeTabs.Trigger>
      ))}
      <NativeTabs.Trigger
        name="more"
        contentStyle={{ backgroundColor: c.ground }}
      >
        <NativeTabs.Trigger.Label>{meTab.label}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={meTab.icon} md={meTab.androidIcon} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
