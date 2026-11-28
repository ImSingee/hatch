import { requireNativeView } from 'expo';
import { useState } from 'react';
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native';
import { appRuntime } from '../native/app-runtime';
import { Busy, Notice } from './primitives';
import { usePalette } from './theme-context';

type EngineState =
  | { state: 'loading' }
  | { state: 'running'; build: number }
  | { state: 'updateAvailable'; build: number }
  | { state: 'failed'; code: string; message: string };

const HatchAppView = requireNativeView<{
  appId: string;
  route?: string;
  style?: object;
  onEngineState?: (event: NativeSyntheticEvent<EngineState>) => void;
  onEngineTitle?: (
    event: NativeSyntheticEvent<{ title: string | null }>,
  ) => void;
  onEngineRoute?: (event: NativeSyntheticEvent<{ route: string }>) => void;
}>('HatchAppView');

/** What the screen shows when an engine cannot run, by the runtime's code. */
function failureText(code: string, message: string) {
  switch (code) {
    case 'APP_PACKAGE_UNAVAILABLE':
      return 'This App was deployed before the platform signed native packages. Deploy it again to open it here.';
    case 'APP_NOT_DEPLOYED':
      return 'This App has no live version yet.';
    case 'APP_ARCHIVED':
      return 'This App is archived. Restore it on the web to open it again.';
    case 'unauthenticated':
      return 'Your session expired. Sign in again to continue.';
    case 'stopped':
      return 'The App was stopped. Open it again to continue where you left off.';
    default:
      return message;
  }
}

/**
 * A `native` App, running on the phone's NSH runtime. The engine belongs to
 * the runtime (one per App, kept while the App waits in the background, see
 * `mobile/native`); this view only shows it, so leaving the screen hides the
 * App without stopping it, and coming back shows it as it was.
 */
export function NativeAppSurface({
  appId,
  route,
  onTitle,
}: {
  appId: string;
  /** The route to open the App at, when it does not run yet. */
  route?: string;
  onTitle?: (title: string | null) => void;
}) {
  const c = usePalette();
  const [state, setState] = useState<EngineState>({ state: 'loading' });
  return (
    <View style={{ flex: 1, backgroundColor: c.card }}>
      <HatchAppView
        appId={appId}
        route={route}
        style={StyleSheet.absoluteFill}
        onEngineState={(event) => setState(event.nativeEvent)}
        onEngineTitle={(event) => onTitle?.(event.nativeEvent.title)}
      />
      {state.state === 'loading' ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: c.card }]}>
          <Busy label="Opening the App" />
        </View>
      ) : state.state === 'failed' ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { padding: 16, backgroundColor: c.ground },
          ]}
        >
          <Notice
            tone="danger"
            title="Couldn’t open this app"
            detail={failureText(state.code, state.message)}
            action={{
              label: 'Try again',
              onPress: () => {
                setState({ state: 'loading' });
                appRuntime.reload(appId);
              },
            }}
          />
        </View>
      ) : state.state === 'updateAvailable' ? (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
          <Notice
            tone="info"
            title="A new version is live"
            detail="Reload to run it. The App keeps running this version until then."
            action={{
              label: 'Reload',
              onPress: () => {
                setState({ state: 'loading' });
                appRuntime.reload(appId);
              },
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
