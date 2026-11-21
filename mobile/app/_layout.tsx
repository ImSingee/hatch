import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { Appearance } from 'react-native';
import { useEffect, type PropsWithChildren } from 'react';
import { AccentProvider, useAccent } from '../src/ui/accent';
import { defaultAccent, fonts, palette as c, weights } from '../src/ui/theme';
import { SessionProvider, useSession } from '../src/state/session';
import { useDeepLinkLifecycle } from '../src/state/deep-links';
import { usePushLifecycle } from '../src/state/push';
import { Busy } from '../src/ui/primitives';
import {
  NavigationProvider,
  useNavigationPreferences,
} from '../src/state/navigation';

function Navigation() {
  const { ready, origin, epoch } = useSession();
  const navigation = useNavigationPreferences();
  usePushLifecycle();
  useDeepLinkLifecycle();
  if (!ready || !navigation.ready) return <Busy label="Opening Hatch…" />;
  return (
    <Stack
      key={epoch}
      screenOptions={{
        contentStyle: { backgroundColor: c.ground },
        statusBarStyle: 'dark',
        headerStyle: { backgroundColor: c.ground },
        headerTintColor: c.ink,
        headerTitleStyle: {
          color: c.ink,
          fontFamily: fonts.sans,
          fontWeight: weights.heading,
        },
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
        <Stack.Screen name="workflows/[id]" options={{ title: '' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Conversation' }} />
        <Stack.Screen name="apps/[id]" options={{ title: 'App' }} />
        <Stack.Screen name="manage/[id]" options={{ title: '' }} />
        <Stack.Screen name="notifications/index" options={{ title: '' }} />
        <Stack.Screen name="notifications/settings" options={{ title: '' }} />
        <Stack.Screen name="notifications/[id]" options={{ title: '' }} />
        <Stack.Screen
          name="settings"
          options={{ title: '', presentation: 'modal' }}
        />
      </Stack.Protected>
    </Stack>
  );
}

function Themed({ children }: PropsWithChildren) {
  const accent = useAccent();
  return (
    <ThemeProvider
      value={{
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
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
  useEffect(() => {
    Appearance.setColorScheme('light');
    return () => Appearance.setColorScheme('auto');
  }, []);
  return (
    // The accent is the theme's one input. Follow-up: read the instance's
    // `ui.theme` accent (the ThemeService RPC of the platform redesign) once
    // signed in and pass its name here; until then every instance shows the
    // token default.
    <AccentProvider name={defaultAccent}>
      <Themed>
        <NavigationProvider>
          <SessionProvider>
            <Navigation />
          </SessionProvider>
        </NavigationProvider>
      </Themed>
    </AccentProvider>
  );
}
