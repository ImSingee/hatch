import { createContext, useContext, type PropsWithChildren } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
  const shown = split && beside && !front.includes(beside.id) ? beside : null;
  return (
    <BesideRoom.Provider value={split !== null}>
      <FoldContainer
        onLayout={onLayout}
        onFolds={onFolds}
        style={{ flex: 1, flexDirection: 'row', backgroundColor: c.ground }}
      >
        {/* Measured widths, never `flex: 1`: a view that drops a width for
            flex kept the old width after a fold (see `ListDetail`). */}
        <View
          style={
            shown && split
              ? { width: split.leading }
              : width
                ? { width }
                : { flex: 1 }
          }
        >
          {children}
        </View>
        {shown && split ? (
          <SafeAreaView
            edges={['top', 'right', 'bottom']}
            style={{
              width: split.trailing,
              marginStart: split.gutter,
              backgroundColor: c.card,
            }}
          >
            <AppView
              key={shown.id}
              id={shown.id}
              slug={shown.slug}
              label={shown.name}
              beside={{
                onHide: () => setBeside(null),
                onClose: () => {
                  setBeside(null);
                  appRuntime.stop(shown.id);
                },
              }}
            />
          </SafeAreaView>
        ) : null}
      </FoldContainer>
    </BesideRoom.Provider>
  );
}
