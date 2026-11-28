import {
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
} from 'react';
import { View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { appRuntime } from '../native/app-runtime';
import { AppView } from '../screens/app-view';
import { useBesideApp, useFrontApps } from '../state/beside';
import { FoldContainer, useFoldSplit } from './columns';
import { usePalette } from './theme-context';

/** Narrowest column an App gets beside the screen in front, and that screen. */
const besideSplit = { minColumn: 360, gap: 16 } as const;

const BesideRoom = createContext(false);

/** Whether the window has room for an App beside the screen in front now. */
export function useBesideRoom() {
  return useContext(BesideRoom);
}

/**
 * The screens, and the App beside them where the window has room for both
 * (`useBesideApp`): two equal columns, or one each side of a display folded
 * part way. The screens keep their place as the App beside comes and goes,
 * and that App keeps running while the window is too narrow for it.
 */
export function BesideLayout({ children }: PropsWithChildren) {
  const c = usePalette();
  const { onLayout, onFolds, width, split } = useFoldSplit(besideSplit);
  const [beside, setBeside] = useBesideApp();
  const front = useFrontApps();
  // An App has one view: while the front shows it, it is not beside too.
  const mounted = beside && !front.includes(beside.id) ? beside : null;
  const shown = split ? mounted : null;
  // While the window is too narrow, a native App's engine runs on without its
  // view; a web App lives in its WebView, which stays mounted, hidden, so the
  // App keeps its page and what was typed into it.
  const kept = !shown && mounted?.runtime !== 'native' ? mounted : null;
  const column = shown ?? kept;
  // The width the column beside had last, kept while it is off-screen.
  const [lastWidth, setLastWidth] = useState<number>(besideSplit.minColumn);
  const trailing = shown && split ? split.trailing : null;
  if (trailing !== null && trailing !== lastWidth) setLastWidth(trailing);
  return (
    <BesideRoom.Provider value={split !== null}>
      <FoldContainer
        onLayout={onLayout}
        onFolds={onFolds}
        style={{ flex: 1, flexDirection: 'row', backgroundColor: c.ground }}
      >
        {/* Measured widths on plain views, never `flex: 1` (a provider adds
            its own): a view that drops a width for flex kept the old width
            after a fold (see `ListDetail`), and flex would split the window
            evenly instead of on the fold. Each
            column is its own safe area: an edge's inset (the vertical bar,
            the notch) belongs only to the column at that edge, and follows
            it as the column narrows. */}
        <View
          style={
            shown && split
              ? { width: split.leading }
              : width
                ? { width }
                : { flex: 1 }
          }
        >
          <SafeAreaProvider>{children}</SafeAreaProvider>
        </View>
        {column ? (
          // Off-screen at its last width while there is no room: a WebView
          // that loses its size draws nothing when it gets one back.
          <View
            style={
              shown && split
                ? {
                    width: split.trailing,
                    marginStart: split.gutter,
                    backgroundColor: c.card,
                  }
                : {
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: '100%',
                    width: lastWidth,
                    opacity: 0,
                  }
            }
            pointerEvents={shown ? 'auto' : 'none'}
            accessibilityElementsHidden={!shown}
            importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
          >
            <SafeAreaProvider>
              <SafeAreaView style={{ flex: 1 }}>
                <AppView
                  key={column.id}
                  id={column.id}
                  slug={column.slug}
                  label={column.name}
                  beside={{
                    onHide: () => setBeside(null),
                    onClose: () => {
                      setBeside(null);
                      appRuntime.stop(column.id);
                    },
                  }}
                />
              </SafeAreaView>
            </SafeAreaProvider>
          </View>
        ) : null}
      </FoldContainer>
    </BesideRoom.Provider>
  );
}
