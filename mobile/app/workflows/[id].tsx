import { useQuery } from '@tanstack/react-query';
import { useIsFocused, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSession } from '../../src/state/session';
import { useLinkedId } from '../../src/state/use-linked-id';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { useAccent } from '../../src/ui/accent';
import { Busy, Notice, errorText } from '../../src/ui/primitives';
import { Facts, ResourceHeader, when } from '../../src/ui/resource';
import { GlyphTile, Group, ListRow } from '../../src/ui/rows';
import { SectionLabel, pageScrollProps } from '../../src/ui/screen';
import { statusText } from '../../src/ui/status';
import { Text, type } from '../../src/ui/text';
import { palette as c, status as hue } from '../../src/ui/theme';

export default function WorkflowScreen() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug?: string }>();
  const { api, origin } = useSession();
  const accent = useAccent();
  const [problem, setProblem] = useState<string | null>(null);
  const linked = useLinkedId('workflows', id, slug);
  const query = useQuery({
    queryKey: [origin, 'workflow', linked.id],
    queryFn: ({ signal }) => api!.workflow(linked.id!, signal),
    enabled: Boolean(api && linked.id),
  });
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const pull = usePullToRefresh(useIsFocused(), () =>
    Promise.all([query.refetch(), workspace.refetch()]),
  );
  const data = query.data;
  // Links open a workflow by its handle; pins are kept by id.
  const pinned =
    (data && workspace.data?.pinnedWorkflowIds.includes(data.id)) ?? false;
  // A failed refresh keeps what was already loaded.
  const failure = linked.error ?? (query.data ? null : query.error);
  if (failure)
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.ground }}>
        <Notice
          tone="danger"
          title="Couldn’t load this workflow"
          detail={errorText(failure)}
          action={{
            label: 'Try again',
            onPress: () => {
              linked.retry();
              void query.refetch();
            },
          }}
        />
      </View>
    );
  if (!data) return <Busy label="Loading workflow" />;
  return (
    <ScrollView
      {...pageScrollProps}
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 32,
      }}
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={accent.fill}
        />
      }
    >
      <ResourceHeader
        workflow
        name={data.name}
        seed={data.id}
        description={
          data.description || 'An automation that runs on your Hatch instance.'
        }
        status={data.status}
        pinned={pinned}
      />
      {query.error ? (
        <View style={{ marginTop: 16 }}>
          <Notice
            tone="danger"
            title="Couldn’t refresh"
            detail={errorText(query.error)}
            action={{
              label: 'Try again',
              onPress: () => void query.refetch(),
            }}
          />
        </View>
      ) : null}
      <SectionLabel>At a glance</SectionLabel>
      <Facts
        items={[
          ['Status', statusText(data.status)],
          ['Updated', when(data.updatedAt)],
          ['Created', when(data.createdAt)],
        ]}
      />
      <SectionLabel>Manage</SectionLabel>
      <Group>
        <ListRow
          title="Manage on the web"
          detail="Triggers, run history and settings"
          leading={<GlyphTile glyph="browser" tone="fill" />}
          accessibilityHint="Opens this Workflow in the browser"
          onPress={() => {
            setProblem(null);
            void WebBrowser.openBrowserAsync(
              `${origin}/workflow/${encodeURIComponent(data.slug)}`,
            ).catch((error: unknown) => setProblem(errorText(error)));
          }}
        />
      </Group>
      {problem ? (
        <Text
          accessibilityRole="alert"
          style={[type.small, { color: hue.danger.ink, marginTop: 8 }]}
        >
          {problem}
        </Text>
      ) : null}
      <Text
        selectable
        style={[type.mono, { marginTop: 12, paddingHorizontal: 4 }]}
      >
        {data.slug} · {data.id}
      </Text>
    </ScrollView>
  );
}
