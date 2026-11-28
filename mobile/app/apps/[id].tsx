import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AppSummary } from '../../src/core';
import { AppView } from '../../src/screens/app-view';
import { useBesideApp, useShowsApp } from '../../src/state/beside';
import { useLinkedId } from '../../src/state/use-linked-id';
import { AppSwitcher } from '../../src/ui/app-switcher';
import { useBesideRoom } from '../../src/ui/beside-layout';
import { ListDetail } from '../../src/ui/columns';
import { usePalette } from '../../src/ui/theme-context';

type AppParams = {
  id: string;
  slug?: string;
  entryHash?: string;
  label?: string;
};

/**
 * An App, full screen. Where the window has room, the instance's Apps sit
 * beside it (`ListDetail`) and a row shows another App here, in place, so
 * back still leaves the screen rather than stepping through Apps.
 */
export default function AppScreen() {
  const c = usePalette();
  // Pins pass their own slug, label and hash; other entries resolve the slug.
  const params = useLocalSearchParams<AppParams>();
  // A link names the App by its slug: the list marks it once resolved.
  const shown = useLinkedId(params.id, params.slug).id ?? undefined;
  // While this screen shows it, the App is not shown beside as well.
  useShowsApp(shown);
  // Covered by another screen, it hands its native App's one view to the
  // column beside, if that shows the same App; with focus back, it takes it
  // again. A web App keeps its page here: the column beside has its own.
  const [beside] = useBesideApp();
  const focused = useIsFocused();
  const room = useBesideRoom();
  const yielded =
    !focused &&
    room &&
    Boolean(shown) &&
    beside !== null &&
    beside.id === shown &&
    beside.runtime === 'native' &&
    !beside.hidden;
  const show = (app: AppSummary) =>
    router.setParams({
      id: app.id,
      slug: app.slug,
      label: app.name,
      entryHash: undefined,
    });
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.ground }}
      edges={['left', 'right']}
    >
      <ListDetail list={<AppSwitcher current={shown} onSelect={show} />}>
        {/* Another App starts over: its own title, attempts and history. */}
        {yielded ? (
          <View style={{ flex: 1, backgroundColor: c.ground }} />
        ) : (
          <AppView key={params.id} {...params} />
        )}
      </ListDetail>
    </SafeAreaView>
  );
}
