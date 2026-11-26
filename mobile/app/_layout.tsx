import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { InstanceTheme } from '../src/state/instance-theme';
import { useTheme } from '../src/ui/theme-context';
import { SessionProvider, useSession } from '../src/state/session';
import { useDeepLinkLifecycle } from '../src/state/deep-links';
import { useUnreadBadge } from '../src/state/notification-read-state';
import { usePushLifecycle } from '../src/state/push';
import { Busy } from '../src/ui/primitives';
import {
  NavigationProvider,
  useNavigationPreferences,
} from '../src/state/navigation';

function Navigation() {
  const { ready, origin, epoch } = useSession();
  const navigation = useNavigationPreferences();
  const { palette: c, appearance } = useTheme();
  usePushLifecycle();
  useDeepLinkLifecycle();
  useUnreadBadge();
  if (!ready || !navigation.ready) return <Busy label="Opening Hatch…" />;
  return (
    <Stack
      key={epoch}
      screenOptions={{
        contentStyle: { backgroundColor: c.ground },
        // Dark glyphs on a light theme, light ones on a dark theme.
        statusBarStyle: appearance === 'dark' ? 'light' : 'dark',
        headerStyle: { backgroundColor: c.ground },
        headerTintColor: c.ink,
        // Navigation bars keep the system font and title weight.
        headerTitleStyle: { color: c.ink },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
      }}
    >
      <Stack.Protected guard={!origin}>
        <Stack.Screen
          name="connect"
          options={{ title: 'Connect to Hatch', headerShown: false }}
        />
      </Stack.Protected>
      <Stack.Protected guard={Boolean(origin)}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="library" options={{ title: '' }} />
        <Stack.Screen name="navigation" options={{ title: '' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="apps/[id]" options={{ title: 'App' }} />
        <Stack.Screen name="manage/[id]" options={{ title: '' }} />
        <Stack.Screen name="pin" options={{ title: '' }} />
        <Stack.Screen name="notifications/index" options={{ title: '' }} />
        <Stack.Screen name="notifications/settings" options={{ title: '' }} />
        <Stack.Screen name="notifications/[id]" options={{ title: '' }} />
        <Stack.Screen
          name="notifications/history/[id]"
          options={{
            title: '',
            presentation: 'formSheet',
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="settings"
          options={{ title: '', presentation: 'modal' }}
        />
      </Stack.Protected>
    </Stack>
  );
}

function Themed({ children }: PropsWithChildren) {
  const { accent, palette: c, appearance } = useTheme();
  const base = appearance === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <ThemeProvider
      value={{
        ...base,
        dark: appearance === 'dark',
        colors: {
          ...base.colors,
          primary: accent.fill,
          background: c.ground,
          card: c.ground,
          text: c.ink,
          border: c.hairline,
        },
      }}
    >
      {children}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    // The theme's one entry: InstanceTheme provides the instance's resolved
    // `ui.theme` (light, dark or the device's), or the built-in desk themes
    // while signed out. It also sets the app's system appearance.
    <NavigationProvider>
      <SessionProvider>
        <InstanceTheme>
          <Themed>
            <Navigation />
          </Themed>
        </InstanceTheme>
      </SessionProvider>
    </NavigationProvider>
  );
}
