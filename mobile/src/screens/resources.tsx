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

/**
 * Every App of the instance as a grid of tiles, searchable, by name or by
 * latest change. A tile opens its App, like a pin on Home; an App without a
 * successful deployment (never deployed, or a first deployment still
 * building or failed) has nothing to open and goes to its App page, which
 * touching and holding any App tile also offers.
 */
export function ResourcesScreen({ nested = false }: { nested?: boolean }) {
  const { api, origin } = useSession();
  const accent = useAccent();
  const focused = useIsFocused();
  const { preferences } = useNavigationPreferences();
  const [order, setOrder] = useState<Order>('name');
  const [search, setSearch] = useState('');
  const apps = useQuery({
    queryKey: [origin, 'apps'],
    queryFn: ({ signal }) => api!.apps(signal),
    enabled: Boolean(api),
  });
  const tile = useShortcutGrid();
  const refresh = () => apps.refetch();
  const pull = usePullToRefresh(focused, refresh);
  const query = search.trim().toLocaleLowerCase();
  const items = (apps.data ?? [])
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
  const failure = apps.error;
  const pending = apps.isPending;
  const details = (item: AppSummary) =>
    router.push({
      pathname: '/manage/[id]',
      params: { id: item.id, slug: item.slug },
    });
  const open = (item: AppSummary) =>
    !item.live
      ? details(item)
      : router.push({
          pathname: '/apps/[id]',
          params: { id: item.id, slug: item.slug, label: item.name },
        });
  return (
    <ScrollScreen
      title="Apps"
      nested={nested}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      actions={
        <IconButton
          label="New App"
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
          label="Search apps"
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
          <Busy label="Gathering apps" />
        ) : !items.length && !failure ? (
          <EmptyState
            glyph={query ? 'search' : 'apps'}
            title={query ? 'Nothing by that name' : 'No apps yet'}
            detail={
              query
                ? 'Try a shorter or different name.'
                : 'Ask your Agent to build something, then find it here.'
            }
          />
        ) : null}
        {!pending && items.length ? (
          <>
            <SectionLabel count={items.length}>Apps</SectionLabel>
            <TileGrid
              items={items}
              keyOf={(item) => item.id}
              minTile={tile.minTile}
              gap={tile.gap}
              render={(item, tileWidth) => (
                <View style={{ width: tileWidth, paddingBottom: 12 }}>
                  <TileMenu
                    actions={[
                      {
                        label: 'App details',
                        glyph: 'info',
                        onPress: () => details(item),
                      },
                    ]}
                  >
                    {(onLongPress) => (
                      <ShortcutTile
                        width={tileWidth}
                        label={item.name}
                        accessibilityLabel={
                          item.live
                            ? item.name
                            : `${item.name}, not deployed yet`
                        }
                        accessibilityHint="Touch and hold for App details"
                        onPress={() => open(item)}
                        onLongPress={onLongPress}
                      >
                        <AppTile
                          name={item.name}
                          seed={item.id}
                          iconPath={item.iconPath}
                          size={tile.tile}
                          lifted
                        />
                      </ShortcutTile>
                    )}
                  </TileMenu>
                </View>
              )}
            />
          </>
        ) : null}
      </View>
    </ScrollScreen>
  );
}
