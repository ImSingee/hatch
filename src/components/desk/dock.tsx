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
  IconLayoutSidebarRight,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPower,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import { AppGlyph } from '~components/apps/app-glyph';
import { AppRouteAutocomplete } from '~components/apps/app-route-autocomplete';
import {
  appsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { openContextMenuFromKeyboard } from '~components/system/context-menu-key';
import { useI18n } from '~i18n';
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
import type { AppSession } from './app-sessions';
import { useSessionActions } from './use-session-actions';
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
 * The dock: pinned Apps, then running Apps that are not pinned, then All
 * apps, with a marker under each running App. Selecting a running App's tile
 * brings it forward as it was. Adding happens in the dock's right-click
 * menu, which also shows a running App beside the window in front and quits
 * it; only an empty Apps group shows an add tile, and a dock with no pins at
 * all shows nothing else.
 */
export function Dock({
  openItems,
  besideAvailable = false,
}: {
  openItems: readonly DockOpenItem[];
  /** Whether an App can be shown beside the window in front right now. */
  besideAvailable?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { sessions, front, sessionOf, quit, openBeside } = useSessionActions();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);
  // Names under the tiles are the user's own setting, off by default.
  const userId = authClient.useSession().data?.user.id;
  const { data: theme } = useQuery({
    ...themeQueryOptions(userId ?? ''),
    enabled: Boolean(userId),
  });
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
      toast.success(t('dock.pinned'));
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
      toast.success(t('dock.unpinned'));
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
      toast.error(t('dock.reorderConflict'));
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

  // Running Apps by id where known: a slug may have changed since one
  // started. Their links use the current slug from the App list.
  const pinnedSlugs = new Set((pins ?? []).map((p) => p.appSlug));
  const running = sessions.filter((session) =>
    session.appId
      ? !pinnedIds.has(session.appId)
      : !pinnedSlugs.has(session.slug),
  );
  const appOf = (session: AppSession) =>
    apps?.find((a) =>
      session.appId ? a.id === session.appId : a.slug === session.slug,
    );
  const sessionMenu = (
    appId: string,
    slug: string,
    entryHash: string | null,
  ) => {
    const session = sessionOf(appId, slug);
    const target = session?.slug ?? slug;
    return (
      <>
        {besideAvailable && front !== target ? (
          <Menu.Item
            leftSection={<IconLayoutSidebarRight size={15} stroke={1.7} />}
            onClick={() => void openBeside(appId, target, entryHash ?? '')}
          >
            {t('dock.openBeside')}
          </Menu.Item>
        ) : null}
        {session ? (
          <Menu.Item
            leftSection={<IconPower size={15} stroke={1.7} />}
            onClick={() => quit(session.slug)}
          >
            {t('dock.quit')}
          </Menu.Item>
        ) : null}
      </>
    );
  };

  const goCreate = () => {
    toast.info(t('dock.createHint'));
    void navigate({ to: '/agent' });
  };

  const appMenu = (item: NonNullable<typeof pins>[number]) => (
    <>
      {sessionMenu(item.appId, item.appSlug, item.entryHash)}
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
        {t('common.edit')}
      </Menu.Item>
      <Menu.Item
        leftSection={<IconPinnedOff size={15} stroke={1.7} />}
        onClick={() => remove.mutate(item.id)}
      >
        {t('dock.unpin')}
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
        {t('common.manage')}
      </Menu.Item>
    </>
  );

  const appPicker: ReactNode = (
    <>
      {unpinnedApps.length > 0 ? (
        <>
          <Menu.Label>{t('dock.pinDeployed')}</Menu.Label>
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
          <Menu.Label>{t('dock.addShortcut')}</Menu.Label>
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
        <Menu.Item disabled>{t('dock.noDeployedApps')}</Menu.Item>
      ) : null}
    </>
  );

  // The right-click menu: the clicked tile's own actions, then adding.
  const clickedPin = pins?.find((p) => `app:${p.id}` === menuKey);
  const clickedRunning = running.find((r) => `run:${r.key}` === menuKey);
  const clickedRunningApp = clickedRunning ? appOf(clickedRunning) : undefined;
  const contextMenu = (
    <>
      {clickedPin ? (
        <>
          <Menu.Label>{clickedPin.label}</Menu.Label>
          {appMenu(clickedPin)}
          <Menu.Divider />
        </>
      ) : null}
      {clickedRunning ? (
        <>
          <Menu.Label>
            {clickedRunningApp?.name ?? clickedRunning.slug}
          </Menu.Label>
          {sessionMenu(clickedRunning.appId ?? '', clickedRunning.slug, null)}
          {clickedRunningApp ? (
            <Menu.Item
              leftSection={<IconPin size={15} stroke={1.7} />}
              disabled={pin.isPending}
              onClick={() => pin.mutate(clickedRunningApp.id)}
            >
              {t('dock.pin')}
            </Menu.Item>
          ) : null}
          <Menu.Item
            leftSection={<IconSettings size={15} stroke={1.7} />}
            renderRoot={(props) => (
              <Link
                to="/app/$appSlug/manage"
                params={{
                  appSlug: clickedRunningApp?.slug ?? clickedRunning.slug,
                }}
                {...props}
              />
            )}
          >
            {t('common.manage')}
          </Menu.Item>
          <Menu.Divider />
        </>
      ) : null}
      <Menu.Sub>
        <Menu.Sub.Target>
          <Menu.Sub.Item leftSection={<IconAppWindow size={15} stroke={1.7} />}>
            {t('dock.addAnApp')}
          </Menu.Sub.Item>
        </Menu.Sub.Target>
        <Menu.Sub.Dropdown miw={220}>{appPicker}</Menu.Sub.Dropdown>
      </Menu.Sub>
      <Menu.Item
        leftSection={<IconSparkles size={15} stroke={1.7} />}
        onClick={goCreate}
      >
        {t('dock.newWithAgent')}
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
            aria-label={t('dock.label')}
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
                      renderItem={(item) => {
                        const open = isAppPinOpen(item, pins, openItems);
                        // The App's only pin stands for the App: it brings
                        // the running App forward as it was. One of several
                        // pins is a page of the App, unless it is the page
                        // the App is on.
                        const single =
                          pins.filter((p) => p.appId === item.appId).length <=
                          1;
                        return (
                          <DockItem
                            label={item.label}
                            open={open}
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
                                state={
                                  single || open
                                    ? { appFocus: true }
                                    : undefined
                                }
                                {...props}
                              />
                            )}
                            hintHidden={menuOpen}
                          />
                        );
                      }}
                    />
                  ) : null}
                  {running.length > 0 ? (
                    <div
                      className={classes.running}
                      data-after-pins={pins?.length ? 'true' : undefined}
                    >
                      {running.map((session) => {
                        const runningApp = appOf(session);
                        const label = runningApp?.name ?? session.slug;
                        return (
                          <DockItem
                            key={session.key}
                            label={label}
                            open
                            menuKey={`run:${session.key}`}
                            glyph={
                              <AppGlyph
                                name={label}
                                seed={runningApp?.id ?? session.slug}
                                size="dock"
                              />
                            }
                            renderLink={(props) => (
                              <Link
                                to="/app/$appSlug"
                                params={{
                                  appSlug: runningApp?.slug ?? session.slug,
                                }}
                                state={{ appFocus: true }}
                                {...props}
                              />
                            )}
                            hintHidden={menuOpen}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                  {pins && pins.length === 0 ? (
                    <DockAddButton
                      label={t('dock.addApp')}
                      hintHidden={menuOpen}
                    >
                      {appPicker}
                    </DockAddButton>
                  ) : null}
                </div>
                {hasPins ? (
                  <DockItem
                    label={t('nav.allApps')}
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
  const { t } = useI18n();
  // Keyed by pin so each opening starts from that pin's values.
  return (
    <Modal
      opened={target !== null}
      onClose={onClose}
      title={t('dock.editPin')}
      centered
    >
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
  const { t } = useI18n();
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
      toast.success(t('dock.pinUpdated'));
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
        <Text size="sm">{t('dock.pinGone')}</Text>
        <Group justify="flex-end">
          <Button type="button" onClick={onClose}>
            {t('common.close')}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <TextInput
        data-autofocus
        label={t('dock.pinName')}
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
        label={t('dock.entryPoint')}
        description={t('dock.entryPointDescription')}
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
          {t('common.save')}
        </Button>
      </Group>
    </Stack>
  );
}
