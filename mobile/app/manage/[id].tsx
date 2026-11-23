import { useQuery } from '@tanstack/react-query';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSession } from '../../src/state/session';
import { useLinkedId } from '../../src/state/use-linked-id';
import { usePullToRefresh } from '../../src/state/use-pull-to-refresh';
import { useAccent } from '../../src/ui/accent';
import { Button } from '../../src/ui/button';
import { Busy, Notice, errorText } from '../../src/ui/primitives';
import { Facts, ResourceHeader, when } from '../../src/ui/resource';
import { GlyphTile, Group, ListRow } from '../../src/ui/rows';
import { SectionLabel, pageScrollProps, readable } from '../../src/ui/screen';
import { statusText } from '../../src/ui/status';
import { Text, type } from '../../src/ui/text';
import { palette as c, status as hue } from '../../src/ui/theme';

/**
 * An App's own page: what it is, how it stands, and the way in. Data tables,
 * schedules, webhooks, the API and deployments are managed on the web.
 */
export default function ManageAppScreen() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug?: string }>();
  const { api, origin } = useSession();
  const accent = useAccent();
  const [problem, setProblem] = useState<string | null>(null);
  const linked = useLinkedId('apps', id, slug);
  const query = useQuery({
    queryKey: [origin, 'app', linked.id],
    queryFn: ({ signal }) => api!.app(linked.id!, signal),
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
  // A failed refresh keeps what was already loaded.
  const failure = linked.error ?? (data ? null : query.error);
  if (failure)
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: c.ground }}>
        <Notice
          tone="danger"
          title="Couldn’t load this app"
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
  if (!data) return <Busy label="Loading app" />;
  const pinned =
    workspace.data?.appPins.some((pin) => pin.appId === data.id) ?? false;
  return (
    <ScrollView
      {...pageScrollProps}
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{
        ...readable,
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
        name={data.name}
        seed={data.id}
        iconPath={data.iconPath}
        description={data.description || 'An App on your Hatch instance.'}
        status={data.status}
        pinned={pinned}
      />
      <View style={{ marginTop: 20, gap: 12 }}>
        <Button
          size="large"
          fullWidth
          label="Open"
          accessibilityHint={`Opens ${data.name}`}
          onPress={() =>
            router.push({
              pathname: '/apps/[id]',
              params: { id: data.id, slug: data.slug },
            })
          }
        />
        {query.error ? (
          <Notice
            tone="danger"
            title="Couldn’t refresh"
            detail={errorText(query.error)}
            action={{ label: 'Try again', onPress: () => void query.refetch() }}
          />
        ) : null}
      </View>
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
          detail="Data, schedules, webhooks, API and deployments"
          leading={<GlyphTile glyph="browser" tone="fill" />}
          accessibilityHint="Opens this App’s management page in the browser"
          onPress={() => {
            setProblem(null);
            void WebBrowser.openBrowserAsync(
              `${origin}/app/${encodeURIComponent(data.slug)}/manage`,
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
