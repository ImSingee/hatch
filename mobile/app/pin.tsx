import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, View } from 'react-native';
import type { AppSummary } from '../src/core';
import { useSession } from '../src/state/session';
import { useLifetimeSignal } from '../src/state/use-lifetime-signal';
import { Busy, EmptyState, Notice, errorText } from '../src/ui/primitives';
import { AppTile, Group, ListRow } from '../src/ui/rows';
import {
  Masthead,
  pageScrollProps,
  readable,
  PageRoot,
} from '../src/ui/screen';
import { sizes } from '../src/ui/theme';

/**
 * Picks an App or a Workflow to pin to the home screen. Pins are shared with
 * every client of the instance. Opened from the grid's "Add" tile.
 */
export default function PinPicker() {
  const { kind } = useLocalSearchParams<{ kind?: string }>();
  const workflow = kind === 'workflows';
  const { api, origin } = useSession();
  const queryClient = useQueryClient();
  const lifetime = useLifetimeSignal();
  const items = useQuery({
    queryKey: [origin, workflow ? 'workflows' : 'apps'],
    queryFn: ({ signal }) =>
      workflow ? api!.workflows(signal) : api!.apps(signal),
    enabled: Boolean(api),
  });
  const pinned = useQuery({
    queryKey: [origin, 'pins'],
    queryFn: ({ signal }) => api!.pins(signal),
    enabled: Boolean(api),
  });
  const pin = useMutation({
    mutationFn: (item: AppSummary) =>
      workflow
        ? api!.setWorkflowPinned(item.id, true, lifetime())
        : api!.pinApp(item.id, lifetime()),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [origin, 'pins'] }),
        queryClient.invalidateQueries({ queryKey: [origin, 'workspace'] }),
      ]);
      if (!lifetime().aborted) router.back();
    },
  });
  const taken = new Set(
    workflow
      ? pinned.data?.workflows.map((item) => item.id)
      : pinned.data?.apps.map((item) => item.appId),
  );
  const choices = (items.data ?? [])
    .filter((item) => item.status !== 'archived' && !taken.has(item.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const failure = items.error ?? pinned.error ?? pin.error;
  const noun = workflow ? 'Workflow' : 'App';
  return (
    <PageRoot nested>
      <ScrollView
        {...pageScrollProps}
        style={{ flex: 1 }}
        contentContainerStyle={{ ...readable, paddingBottom: 32 }}
      >
        <Masthead
          nested
          eyebrow="Shown on every device"
          title={`Pin ${workflow ? 'a Workflow' : 'an App'}`}
        />
        <View style={{ paddingHorizontal: 16, gap: 12 }}>
          {failure ? (
            <Notice
              tone="danger"
              title={pin.error ? `Couldn’t pin this ${noun}` : 'Couldn’t load'}
              detail={errorText(failure)}
            />
          ) : null}
          {items.isPending || pinned.isPending ? (
            <Busy label={`Gathering ${noun}s`} />
          ) : choices.length ? (
            <Group>
              {choices.map((item) => (
                <ListRow
                  key={item.id}
                  title={item.name}
                  detail={item.description || undefined}
                  accessibilityHint="Pins it to the home screen"
                  leading={
                    <AppTile
                      name={item.name}
                      seed={item.id}
                      iconPath={item.iconPath}
                      workflow={workflow}
                      size={sizes.dockTile}
                    />
                  }
                  onPress={() => {
                    if (!pin.isPending) pin.mutate(item);
                  }}
                />
              ))}
            </Group>
          ) : failure ? null : (
            <EmptyState
              glyph="pin"
              title={`Every ${noun} is pinned`}
              detail={`${noun}s you create later can be pinned from here.`}
            />
          )}
        </View>
      </ScrollView>
    </PageRoot>
  );
}
