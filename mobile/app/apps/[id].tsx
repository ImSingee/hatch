import { useQuery } from '@tanstack/react-query';
import {
  Stack,
  router,
  useFocusEffect,
  useLocalSearchParams,
} from 'expo-router';
import { useCallback, useId, useRef, useState } from 'react';
import { BackHandler, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  appDestination,
  type BrowserDestination,
  type DeepLink,
} from '../../src/core';
import { appRuntime } from '../../src/native/app-runtime';
import { openSurfaceLink } from '../../src/state/deep-links';
import { useNativeAppRuntime } from '../../src/state/native-apps';
import { NativeAppSurface } from '../../src/ui/native-app-surface';
import { SecureSurface, type SurfaceHandle } from '../../src/ui/secure-surface';
import { useSession } from '../../src/state/session';
import { VerticalBarProbe } from '../../src/ui/fold-probe';
import { useLinkedId } from '../../src/state/use-linked-id';
import { useWebHistoryBack } from '../../src/state/use-web-history-back';
import { glyphs } from '../../src/ui/glyph.types';
import { Busy, Notice, errorText } from '../../src/ui/primitives';
import { usePalette } from '../../src/ui/theme-context';

/** The platform this app names to the Apps it opens. */
const shellPlatform =
  Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : undefined;

export default function AppScreen() {
  const c = usePalette();
  // Pins pass their own slug, label and hash; other entries resolve the slug.
  const { id, slug, entryHash, label } = useLocalSearchParams<{
    id: string;
    slug?: string;
    entryHash?: string;
    label?: string;
  }>();
  const { api, origin, epoch } = useSession();
  const [attempt, setAttempt] = useState(0);
  // Each screen signs in with its own one-use ticket, even for the same App.
  const screen = useId();
  // Back steps through the App's own pages first, then leaves the screen.
  const surface = useRef<SurfaceHandle>(null);
  const [inPageBack, setInPageBack] = useState(false);
  // Where the system moves the navigation bar's items to a vertical bar (an
  // iPhone Duo), back and reload live there and a top bar would hold only
  // the title: the App takes the whole height instead.
  const [verticalBar, setVerticalBar] = useState(false);
  useWebHistoryBack(inPageBack, () => surface.current?.goBack());
  const linked = useLinkedId(id, slug);
  const app = useQuery({
    queryKey: [origin, 'app', linked.id],
    queryFn: ({ signal }) => api!.app(linked.id!, signal),
    enabled: Boolean(api && linked.id),
  });
  const appSlug = slug || app.data?.slug;
  // A `native` App runs on the phone's runtime; every other in a WebView.
  const native =
    appRuntime.available && app.data?.runtime === 'native' ? app.data : null;
  const [nativeTitle, setNativeTitle] = useState<string | null>(null);
  const runtimeReady = useNativeAppRuntime();
  // Android's back gesture goes back in the App first, then leaves the screen.
  useFocusEffect(
    useCallback(() => {
      if (!native || Platform.OS !== 'android') return;
      const appId = native.id;
      // The App answers later: by then this screen may have gone.
      let focused = true;
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          void appRuntime.handleBack(appId).then((handled) => {
            if (focused && !handled && router.canGoBack()) router.back();
          });
          return true;
        },
      );
      return () => {
        focused = false;
        subscription.remove();
      };
    }, [native]),
  );
  let destination: BrowserDestination | null = null;
  let invalid: unknown = null;
  try {
    destination = appSlug
      ? appDestination(appSlug, entryHash, shellPlatform)
      : null;
  } catch (error) {
    invalid = error;
  }
  const handoff = useQuery({
    queryKey: [origin, 'browser-handoff', 'app', id, screen, epoch, attempt],
    queryFn: ({ signal }) => api!.createHandoff(signal),
    // Only for a `web` App: a `native` one runs without the browser.
    enabled: Boolean(api && destination && app.data && !native),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retry = () => {
    linked.retry();
    void app.refetch();
    if (native) appRuntime.reload(native.id);
    setAttempt((value) => value + 1);
  };
  // A link to this App's own route moves this page there as a step in its
  // history, so back returns to the page it came from; anything else opens
  // over it.
  const route = (link: DeepLink) => {
    const { target } = link;
    if (
      (link.instance ?? origin) === origin &&
      target.kind === 'app' &&
      target.slug === appSlug
    ) {
      if (native) appRuntime.navigate(native.id, target.hash ?? '');
      else surface.current?.showRoute(target.hash ?? '');
    } else openSurfaceLink(link);
  };
  const data = handoff.data;
  const name = nativeTitle || label || app.data?.name || 'App';
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.card }}
      edges={['left', 'right']}
    >
      <Stack.Screen
        options={{
          title: verticalBar ? '' : name,
          gestureEnabled: !inPageBack,
          headerTransparent: verticalBar,
          // A transparent bar still paints its own background, which would
          // leave a band the bar's height above the App.
          headerStyle: {
            backgroundColor: verticalBar ? 'transparent' : c.card,
          },
          headerShadowVisible: !verticalBar,
        }}
      />
      {/* A native bar item, not a custom view, so the system can move it to
          the vertical bar on iPhone Duo or into the overflow menu. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={glyphs.refresh} onPress={retry}>
          Reload app
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <VerticalBarProbe onChange={(edge) => setVerticalBar(edge !== 'none')} />
      {invalid ||
      linked.error ||
      (handoff.error && !native) ||
      (app.error && !destination) ? (
        <View style={{ flex: 1, padding: 16, backgroundColor: c.ground }}>
          <Notice
            tone="danger"
            title="Couldn’t open this app"
            detail={errorText(
              invalid ??
                linked.error ??
                (native ? null : handoff.error) ??
                app.error,
            )}
            action={{ label: 'Try again', onPress: retry }}
          />
        </View>
      ) : native && !runtimeReady ? (
        <Busy label={`Opening ${name}`} />
      ) : native ? (
        <NativeAppSurface
          appId={native.id}
          route={entryHash}
          onTitle={setNativeTitle}
        />
      ) : !data || !destination ? (
        <Busy label={`Opening ${name}`} />
      ) : (
        <SecureSurface
          ref={surface}
          key={`${epoch}-${attempt}`}
          origin={origin!}
          handoff={data}
          destination={destination}
          retry={retry}
          onHistoryBack={setInPageBack}
          onRoute={route}
        />
      )}
    </SafeAreaView>
  );
}
