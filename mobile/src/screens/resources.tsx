import { useQuery } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, View } from 'react-native';
import type { AppSummary } from '../core';
import { useNavigationPreferences } from '../state/navigation';
import { openSection } from '../state/open-section';
import { useSession } from '../state/session';
import { usePullToRefresh } from '../state/use-pull-to-refresh';
import { useAccent } from '../ui/accent';
import { IconButton } from '../ui/button';
import { Reflow } from '../ui/columns';
import { NativeField } from '../ui/native-field';
import { Busy, EmptyState, Notice, errorText } from '../ui/primitives';
import { AppTile, Group, ListRow } from '../ui/rows';
import { ScopeTabs } from '../ui/scope-tabs';
import { ScrollScreen, SectionLabel } from '../ui/screen';

type Order = 'name' | 'recent';
type Kind = 'apps' | 'workflows';

/**
 * Every App and Workflow of the instance, searchable, by name or by latest
 * change. Pinned ones carry a pin; the pins themselves live on the home
 * screen. The Workflows tab lists Workflows alone.
 */
export function ResourcesScreen({
  kind = 'apps',
  nested = false,
}: {
  kind?: Kind;
  nested?: boolean;
}) {
  const { api, origin } = useSession();
  const accent = useAccent();
  const focused = useIsFocused();
  const { preferences } = useNavigationPreferences();
  const [order, setOrder] = useState<Order>('name');
  const [search, setSearch] = useState('');
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api) && kind === 'apps',
  });
  const workflows = useQuery({
    queryKey: [origin, 'workflows'],
    queryFn: ({ signal }) => api!.workflows(signal),
    enabled: Boolean(api),
  });
  const workspace = useQuery({
    queryKey: [origin, 'workspace'],
    queryFn: ({ signal }) => api!.workspace(signal),
    enabled: Boolean(api),
  });
  const refresh = () =>
    Promise.all([
      workflows.refetch(),
      workspace.refetch(),
      ...(kind === 'apps' ? [apps.refetch()] : []),
    ]);
  const pull = usePullToRefresh(focused, refresh);
  const query = search.trim().toLocaleLowerCase();
  const arrange = (items: AppSummary[] | undefined) =>
    (items ?? [])
      .filter(
        (item) =>
          item.status !== 'archived' &&
          item.name.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) =>
        order === 'name'
          ? a.name.localeCompare(b.name)
          : b.updatedAt.localeCompare(a.updatedAt),
      );
  const pinnedApps = new Set(
    (workspace.data?.appPins ?? []).map((pin) => pin.appId),
  );
  const pinnedWorkflows = new Set(workspace.data?.pinnedWorkflowIds ?? []);
  const sections: { kind: Kind; title: string; items: AppSummary[] }[] = [
    ...(kind === 'apps'
      ? [{ kind: 'apps' as const, title: 'Apps', items: arrange(apps.data) }]
      : []),
    { kind: 'workflows', title: 'Workflows', items: arrange(workflows.data) },
  ];
  const total = sections.reduce(
    (sum, section) => sum + section.items.length,
    0,
  );
  // The lists matter; a failed pin lookup only hides the pin marks.
  const failure = (kind === 'apps' ? apps.error : null) ?? workflows.error;
  const pending = (kind === 'apps' && apps.isPending) || workflows.isPending;
  const open = (item: AppSummary, of: Kind) =>
    router.push({
      pathname: of === 'apps' ? '/manage/[id]' : '/workflows/[id]',
      params:
        of === 'apps' ? { id: item.id, slug: item.slug } : { id: item.id },
    });
  const noun = kind === 'apps' ? 'Apps' : 'Workflows';
  return (
    <ScrollScreen
      title={noun}
      nested={nested}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      actions={
        <IconButton
          label={kind === 'apps' ? 'New App' : 'New Workflow'}
          glyph="plus"
          tone="clear"
          onPress={() => openSection('agent', preferences)}
        />
      }
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
          tintColor={accent.fill}
        />
      }
    >
      <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
        <NativeField
          variant="search"
          label={`Search ${kind}`}
          placeholder="Search"
          value={search}
          onChange={setSearch}
        />
      </View>
      <ScopeTabs<Order>
        label="Order"
        value={order}
        onChange={setOrder}
        options={[
          { value: 'name', label: 'A–Z' },
          { value: 'recent', label: 'Recent' },
        ]}
      />
      <View style={{ paddingHorizontal: 16 }}>
        {failure ? (
          <View style={{ marginTop: 16 }}>
            <Notice
              tone="danger"
              title="Couldn’t refresh"
              detail={errorText(failure)}
              action={{ label: 'Try again', onPress: refresh }}
            />
          </View>
        ) : null}
        {pending ? (
          <Busy label={`Gathering ${kind}`} />
        ) : !total && !failure ? (
          <EmptyState
            glyph={query ? 'search' : kind}
            title={query ? 'Nothing by that name' : `No ${kind} yet`}
            detail={
              query
                ? 'Try a shorter or different name.'
                : kind === 'apps'
                  ? 'Ask your Agent to build something, then find it here.'
                  : 'Workflows you create on your instance will appear here.'
            }
          />
        ) : null}
        {pending
          ? null
          : sections.map((section) =>
              section.items.length ? (
                <View key={section.kind}>
                  <SectionLabel count={section.items.length}>
                    {section.title}
                  </SectionLabel>
                  <Reflow
                    items={section.items}
                    render={(column) => (
                      <Group>
                        {column.map((item) => {
                          const pinned = (
                            section.kind === 'apps'
                              ? pinnedApps
                              : pinnedWorkflows
                          ).has(item.id);
                          return (
                            <ListRow
                              key={item.id}
                              title={item.name}
                              detail={item.description || undefined}
                              mark={
                                pinned
                                  ? { glyph: 'pin', label: 'pinned' }
                                  : undefined
                              }
                              leading={
                                <AppTile
                                  name={item.name}
                                  seed={item.id}
                                  iconPath={item.iconPath}
                                  workflow={section.kind === 'workflows'}
                                  size={40}
                                />
                              }
                              onPress={() => open(item, section.kind)}
                            />
                          );
                        })}
                      </Group>
                    )}
                  />
                </View>
              ) : null,
            )}
      </View>
    </ScrollScreen>
  );
}
