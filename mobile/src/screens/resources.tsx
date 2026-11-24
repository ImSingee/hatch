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
import { TileGrid } from '../ui/columns';
import { NativeField } from '../ui/native-field';
import { Busy, EmptyState, Notice, errorText } from '../ui/primitives';
import { AppTile, ShortcutTile, useShortcutGrid } from '../ui/rows';
import { ScopeTabs } from '../ui/scope-tabs';
import { ScrollScreen, SectionLabel } from '../ui/screen';
import { TileMenu } from '../ui/tile-menu';

type Order = 'name' | 'recent';
type Kind = 'apps' | 'workflows';

/**
 * Every App and Workflow of the instance as a grid of tiles, searchable, by
 * name or by latest change. A tile opens its App, like a pin on Home; an App
 * without a successful deployment (never deployed, or a first deployment
 * still building or failed) has nothing to open and goes to its App page,
 * which touching and holding any App tile also offers. The Workflows tab
 * lists Workflows alone.
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
  const tile = useShortcutGrid();
  const refresh = () =>
    Promise.all([
      workflows.refetch(),
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
  const failure = (kind === 'apps' ? apps.error : null) ?? workflows.error;
  const pending = (kind === 'apps' && apps.isPending) || workflows.isPending;
  const details = (item: AppSummary) =>
    router.push({
      pathname: '/manage/[id]',
      params: { id: item.id, slug: item.slug },
    });
  const open = (item: AppSummary, of: Kind) =>
    of === 'workflows'
      ? router.push({ pathname: '/workflows/[id]', params: { id: item.id } })
      : !item.live
        ? details(item)
        : router.push({
            pathname: '/apps/[id]',
            params: { id: item.id, slug: item.slug, label: item.name },
          });
  const tileOf = (
    item: AppSummary,
    of: Kind,
    width: number,
    onLongPress?: () => void,
  ) => (
    <ShortcutTile
      width={width}
      label={item.name}
      accessibilityLabel={
        of === 'apps'
          ? !item.live
            ? `${item.name}, not deployed yet`
            : item.name
          : `${item.name}, workflow`
      }
      accessibilityHint={
        of === 'apps' ? 'Touch and hold for App details' : undefined
      }
      onPress={() => open(item, of)}
      onLongPress={onLongPress}
    >
      <AppTile
        name={item.name}
        seed={item.id}
        iconPath={item.iconPath}
        workflow={of === 'workflows'}
        size={tile.tile}
        lifted
      />
    </ShortcutTile>
  );
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
                  <TileGrid
                    items={section.items}
                    keyOf={(item) => item.id}
                    minTile={tile.minTile}
                    gap={tile.gap}
                    render={(item, tileWidth) => (
                      <View style={{ width: tileWidth, paddingBottom: 12 }}>
                        {section.kind === 'apps' ? (
                          <TileMenu
                            actions={[
                              {
                                label: 'App details',
                                glyph: 'info',
                                onPress: () => details(item),
                              },
                            ]}
                          >
                            {(onLongPress) =>
                              tileOf(item, 'apps', tileWidth, onLongPress)
                            }
                          </TileMenu>
                        ) : (
                          tileOf(item, 'workflows', tileWidth)
                        )}
                      </View>
                    )}
                  />
                </View>
              ) : null,
            )}
      </View>
    </ScrollScreen>
  );
}
