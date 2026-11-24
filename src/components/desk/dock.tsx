import {
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconPencil,
  IconPinnedOff,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { AppRouteAutocomplete } from '~components/apps/app-route-autocomplete';
import {
  appsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { openContextMenuFromKeyboard } from '~components/system/context-menu-key';
import { themeQueryOptions } from '~queries/theme';
import {
  addSidebarItem,
  removeSidebarItem,
  reorderSidebarItems,
  setSidebarPin,
  updateSidebarItem,
} from '~server/sidebar';
import {
  AllAppsGlyph,
  DockAddButton,
  DockItem,
  type DockOpenItem,
} from './dock-item';
import { SortableList, sortByIds } from './sortable-list';
import classes from './dock.module.css';

// Hash routers report their home page as '/', while a pin without an entry
// point targets the App root as ''.
const rootAsEmpty = (route: string) => (route === '/' ? '' : route);

type AppPin = { appId: string; appSlug: string; entryHash: string | null };

/**
 * Whether a pin's window is open. An App pinned once is marked wherever the
 * App is; an App pinned several times marks only the pin whose entry point
 * matches the open route.
 */
export function isAppPinOpen(
  pin: AppPin,
  pins: readonly AppPin[],
  openItems: readonly DockOpenItem[],
) {
  const single = pins.filter((p) => p.appId === pin.appId).length <= 1;
  return openItems.some(
    (item) =>
      item.kind === 'app' &&
      item.slug === pin.appSlug &&
      (single || rootAsEmpty(item.route) === rootAsEmpty(pin.entryHash ?? '')),
  );
}

/** Which tile a right-click landed on, from its `data-dock-key`. */
function dockKeyOf(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return (
    target.closest<HTMLElement>('[data-dock-key]')?.dataset.dockKey ?? null
  );
}

/**
 * The dock: pinned Apps, then All apps, with a marker under each one whose
 * window is open. Adding happens in
 * the dock's right-click menu; only an empty Apps group shows an add tile,
 * and a dock with no pins at all shows nothing else.
 */
export function Dock({ openItems }: { openItems: readonly DockOpenItem[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);
  // Names under the tiles are an instance setting, off by default.
  const { data: theme } = useQuery(themeQueryOptions);
  const labels = theme?.dockLabels ?? false;
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    appId: string;
    label: string;
    entryHash: string;
  } | null>(null);

  const invalidatePins = () =>
    queryClient.invalidateQueries({
      queryKey: sidebarItemsQueryOptions.queryKey,
    });
  // Every pin mutation refetches when it settles, not only on success: a
  // failure usually means the dock is stale (the pin was removed or the App
  // archived elsewhere), and the refetch drops what no longer exists. The
  // error itself is toasted by the global mutation handler.

  // First-time pin: idempotent (server uses an advisory lock) so a double-click
  // on an unpinned app can't create duplicate root shortcuts.
  const pin = useMutation({
    mutationFn: (appId: string) =>
      setSidebarPin({ data: { appId, pinned: true } }),
    onSuccess: () => {
      toast.success('Pinned to the dock');
    },
    onSettled: () => void invalidatePins(),
  });

  // Extra shortcut for an already-pinned app: always inserts a new pin, then
  // jumps into editing so it can be given a distinct name/entry point.
  const add = useMutation({
    mutationFn: (appId: string) => addSidebarItem({ data: { appId } }),
    onSettled: () => void invalidatePins(),
    onSuccess: (row) => {
      if (row) {
        setEditTarget({
          id: row.id,
          appId: row.appId,
          label: row.label,
          entryHash: '',
        });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeSidebarItem({ data: { id } }),
    onSuccess: () => {
      toast.success('Unpinned');
    },
    onSettled: () => void invalidatePins(),
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderSidebarItems({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData(sidebarItemsQueryOptions.queryKey, (old) =>
        sortByIds(old, orderedIds),
      );
    },
    // The server names the stale pin by id, which means nothing here.
    meta: { errorToast: false },
    onError: () => {
      toast.error(
        'The dock changed while you were moving that pin. It now shows the current order; try again.',
      );
    },
    onSettled: () => void invalidatePins(),
  });

  // Only deployed apps with a frontend can be opened from the dock.
  const openable = (apps ?? []).filter(
    (s) => s.status === 'deployed' && Boolean(s.capabilities?.frontend),
  );
  const pinnedIds = new Set((pins ?? []).map((p) => p.appId));
  const unpinnedApps = openable.filter((s) => !pinnedIds.has(s.id));
  const pinnedApps = openable.filter((s) => pinnedIds.has(s.id));
  // All apps closes the Apps group once anything is pinned; an empty dock
  // shows only its add tile.
  const hasPins = Boolean(pins?.length);

  const goCreate = () => {
    toast.info('Tell the Agent what App to build');
    void navigate({ to: '/agent' });
  };

  const appMenu = (item: NonNullable<typeof pins>[number]) => (
    <>
      <Menu.Item
        leftSection={<IconPencil size={15} stroke={1.7} />}
        onClick={() =>
          setEditTarget({
            id: item.id,
            appId: item.appId,
            label: item.label,
            entryHash: item.entryHash ?? '',
          })
        }
      >
        Edit
      </Menu.Item>
      <Menu.Item
        leftSection={<IconPinnedOff size={15} stroke={1.7} />}
        onClick={() => remove.mutate(item.id)}
      >
        Unpin
      </Menu.Item>
      <Menu.Item
        leftSection={<IconSettings size={15} stroke={1.7} />}
        renderRoot={(props) => (
          <Link
            to="/app/$appSlug/manage"
            params={{ appSlug: item.appSlug }}
            {...props}
          />
        )}
      >
        Manage
      </Menu.Item>
    </>
  );

  const appPicker: ReactNode = (
    <>
      {unpinnedApps.length > 0 ? (
        <>
          <Menu.Label>Pin a deployed app</Menu.Label>
          {unpinnedApps.map((s) => (
            <Menu.Item
              key={s.id}
              leftSection={<IconAppWindow size={16} stroke={1.6} />}
              disabled={pin.isPending}
              onClick={() => pin.mutate(s.id)}
            >
              <Text size="sm" truncate>
                {s.name}
              </Text>
            </Menu.Item>
          ))}
        </>
      ) : null}
      {pinnedApps.length > 0 ? (
        <>
          <Menu.Label>Add another shortcut</Menu.Label>
          {pinnedApps.map((s) => (
            <Menu.Item
              key={s.id}
              leftSection={<IconAppWindow size={16} stroke={1.6} />}
              disabled={add.isPending}
              onClick={() => add.mutate(s.id)}
            >
              <Text size="sm" truncate>
                {s.name}
              </Text>
            </Menu.Item>
          ))}
        </>
      ) : null}
      {openable.length === 0 ? (
        <Menu.Item disabled>No deployed apps yet</Menu.Item>
      ) : null}
    </>
  );

  // The right-click menu: the clicked tile's own actions, then adding.
  const clickedPin = pins?.find((p) => `app:${p.id}` === menuKey);
  const contextMenu = (
    <>
      {clickedPin ? (
        <>
          <Menu.Label>{clickedPin.label}</Menu.Label>
          {appMenu(clickedPin)}
          <Menu.Divider />
        </>
      ) : null}
      <Menu.Sub>
        <Menu.Sub.Target>
          <Menu.Sub.Item leftSection={<IconAppWindow size={15} stroke={1.7} />}>
            Add an app
          </Menu.Sub.Item>
        </Menu.Sub.Target>
        <Menu.Sub.Dropdown miw={220}>{appPicker}</Menu.Sub.Dropdown>
      </Menu.Sub>
      <Menu.Item
        leftSection={<IconSparkles size={15} stroke={1.7} />}
        onClick={goCreate}
      >
        New with Agent
      </Menu.Item>
    </>
  );

  return (
    <>
      {/* Like a native context menu, it leaves focus where it was: a tile
          focused by the right-click would keep the dock up with a ring once
          a key (Escape) closes the menu. */}
      <Menu
        shadow="md"
        width={220}
        returnFocus={false}
        onOpen={() => setMenuOpen(true)}
        onClose={() => {
          setMenuOpen(false);
          setMenuKey(null);
        }}
      >
        <Menu.ContextMenu>
          {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Only keeps a right-click from moving focus, notes which tile a long press is on, and opens the menu from Shift+F10; the dock's tiles stay the interactive elements. */}
          <nav
            aria-label="Dock"
            className={classes.dock}
            data-labels={labels ? 'shown' : 'hidden'}
            onMouseDown={(event) => {
              if (event.button === 2) event.preventDefault();
            }}
            onContextMenu={(event) => setMenuKey(dockKeyOf(event.target))}
            // A long press opens the menu without a contextmenu event, so
            // note the pressed tile when the touch starts.
            onTouchStart={(event) => setMenuKey(dockKeyOf(event.target))}
            onKeyDown={openContextMenuFromKeyboard}
          >
            <div className={classes.group}>
              <div className={classes.groupBody}>
                <div className={classes.row}>
                  {pins && pins.length > 0 ? (
                    <SortableList
                      items={pins}
                      onReorder={(ids) => reorder.mutate(ids)}
                      renderItem={(item) => (
                        <DockItem
                          label={item.label}
                          open={isAppPinOpen(item, pins, openItems)}
                          menuKey={`app:${item.id}`}
                          glyph={
                            <AppGlyph
                              name={item.label}
                              seed={item.appId}
                              size="dock"
                            />
                          }
                          renderLink={(props) => (
                            <Link
                              to="/app/$appSlug"
                              params={{ appSlug: item.appSlug }}
                              hash={item.entryHash ?? undefined}
                              {...props}
                            />
                          )}
                          hintHidden={menuOpen}
                        />
                      )}
                    />
                  ) : null}
                  {pins && pins.length === 0 ? (
                    <DockAddButton label="Add app" hintHidden={menuOpen}>
                      {appPicker}
                    </DockAddButton>
                  ) : null}
                </div>
                {hasPins ? (
                  <DockItem
                    label="All apps"
                    open={pathname === '/apps'}
                    glyph={<AllAppsGlyph />}
                    renderLink={(props) => <Link to="/apps" {...props} />}
                    hintHidden={menuOpen}
                  />
                ) : null}
              </div>
            </div>
          </nav>
        </Menu.ContextMenu>
        <Menu.Dropdown>{contextMenu}</Menu.Dropdown>
      </Menu>

      <EditPinDialog
        target={editTarget}
        present={Boolean(
          editTarget && pins?.some((item) => item.id === editTarget.id),
        )}
        onClose={() => setEditTarget(null)}
        onSaved={() => void invalidatePins()}
      />
    </>
  );
}

/** Rename a pin or point it at a page inside its App. */
function EditPinDialog({
  target,
  present,
  onClose,
  onSaved,
}: {
  target: {
    id: string;
    appId: string;
    label: string;
    entryHash: string;
  } | null;
  /** Whether the edited pin is in the live pins. */
  present: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Keyed by pin so each opening starts from that pin's values.
  return (
    <Modal opened={target !== null} onClose={onClose} title="Edit pin" centered>
      {target ? (
        <EditPinForm
          key={target.id}
          target={target}
          present={present}
          onClose={onClose}
          onSaved={onSaved}
        />
      ) : null}
    </Modal>
  );
}

function EditPinForm({
  target,
  present,
  onClose,
  onSaved,
}: {
  target: { id: string; appId: string; label: string; entryHash: string };
  present: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(target.label);
  const [hash, setHash] = useState(target.entryHash);
  // Whether the pin has been seen in the live pins since the dialog opened:
  // a pin just added may not be in the list yet, and only a pin that was
  // there and is now missing was removed elsewhere.
  const [seen, setSeen] = useState(false);
  if (present && !seen) setSeen(true);
  const gone = seen && !present;
  const { data: manifest } = useQuery(
    normalizedManifestQueryOptions(target.appId),
  );

  const update = useMutation({
    mutationFn: (input: { id: string; label: string; entryHash: string }) =>
      updateSidebarItem({ data: input }),
    onSuccess: () => {
      toast.success('Pin updated');
    },
    // Close on failure too: the pin being edited may be gone.
    onSettled: () => {
      onClose();
      onSaved();
    },
  });

  const submit = () => {
    if (label.trim()) {
      update.mutate({ id: target.id, label: label.trim(), entryHash: hash });
    }
  };

  if (gone) {
    return (
      <Stack gap="sm">
        <Text size="sm">
          This pin was removed from the dock elsewhere, so there is nothing left
          to edit.
        </Text>
        <Group justify="flex-end">
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <TextInput
        data-autofocus
        label="Name"
        value={label}
        onChange={(e) => setLabel(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <AppRouteAutocomplete
        routes={manifest?.app?.routes ?? []}
        label="Entry point"
        description="Open the app at a specific page. Leave blank for the app home."
        placeholder="/settings"
        value={hash}
        onChange={setHash}
      />
      <Group justify="flex-end">
        <Button
          type="button"
          loading={update.isPending}
          disabled={!label.trim()}
          onClick={submit}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
}
