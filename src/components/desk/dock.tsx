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
import { Link, useNavigate } from '@tanstack/react-router';
import {
  IconAppWindow,
  IconLayoutGrid,
  IconPencil,
  IconRepeat,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { AppRouteAutocomplete } from '~components/apps/app-route-autocomplete';
import {
  appsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { sidebarItemsQueryOptions } from '~queries/sidebar';
import { workflowsQueryOptions } from '~queries/workflows';
import {
  addSidebarItem,
  removeSidebarItem,
  reorderSidebarItems,
  setSidebarPin,
  updateSidebarItem,
} from '~server/sidebar';
import { setWorkflowPinFn } from '~server/workflows';
import { DockAddButton, DockItem, type DockOpenItem } from './dock-item';
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

/**
 * The dock: pinned Apps and Workflows, a marker under each one whose window
 * is open, and an add tile per group that opens the pin picker.
 */
export function Dock({ openItems }: { openItems: readonly DockOpenItem[] }) {
  return (
    <nav aria-label="Dock" className={classes.dock}>
      <DockApps openItems={openItems} />
      <span aria-hidden className={classes.divider} />
      <DockWorkflows openItems={openItems} />
    </nav>
  );
}

function DockApps({ openItems }: { openItems: readonly DockOpenItem[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: pins } = useQuery(sidebarItemsQueryOptions);
  const { data: apps } = useQuery(appsQueryOptions);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    appId: string;
  } | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editHash, setEditHash] = useState('');
  const editedAppId = editTarget?.appId ?? '';
  const { data: editedManifest } = useQuery({
    ...normalizedManifestQueryOptions(editedAppId),
    enabled: Boolean(editedAppId),
  });

  const invalidate = () =>
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
    onSettled: () => void invalidate(),
  });

  // Extra shortcut for an already-pinned app: always inserts a new pin, then
  // jumps into editing so it can be given a distinct name/entry point.
  const add = useMutation({
    mutationFn: (appId: string) => addSidebarItem({ data: { appId } }),
    onSettled: () => void invalidate(),
    onSuccess: (row) => {
      if (row) {
        setEditTarget({ id: row.id, appId: row.appId });
        setEditLabel(row.label);
        setEditHash('');
      }
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeSidebarItem({ data: { id } }),
    onSuccess: () => {
      toast.success('Unpinned');
    },
    onSettled: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; label: string; entryHash: string }) =>
      updateSidebarItem({ data: input }),
    onSuccess: () => {
      toast.success('Pin updated');
    },
    // Close on failure too: the pin being edited may be gone.
    onSettled: () => {
      setEditTarget(null);
      void invalidate();
    },
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      reorderSidebarItems({ data: orderedIds }),
    onMutate: (orderedIds) => {
      queryClient.setQueryData(sidebarItemsQueryOptions.queryKey, (old) =>
        sortByIds(old, orderedIds),
      );
    },
    onSettled: () => void invalidate(),
  });

  // Only deployed apps with a frontend can be opened from the dock.
  const openable = (apps ?? []).filter(
    (s) => s.status === 'deployed' && Boolean(s.capabilities?.frontend),
  );
  const pinnedIds = new Set((pins ?? []).map((p) => p.appId));
  const unpinnedApps = openable.filter((s) => !pinnedIds.has(s.id));
  const pinnedApps = openable.filter((s) => pinnedIds.has(s.id));

  const submitEdit = () => {
    if (editTarget && editLabel.trim()) {
      update.mutate({
        id: editTarget.id,
        label: editLabel.trim(),
        entryHash: editHash,
      });
    }
  };

  const goCreateApp = () => {
    toast.info('Create a new app by chatting with the Agent');
    void navigate({ to: '/agent' });
  };

  return (
    <div className={`${classes.group} ${classes.grow}`}>
      <span className={classes.groupLabel}>Apps</span>
      <div className={classes.row}>
        {pins ? (
          <>
            <SortableList
              items={pins}
              onReorder={(ids) => reorder.mutate(ids)}
              renderItem={(item) => (
                <DockItem
                  label={item.label}
                  open={isAppPinOpen(item, pins, openItems)}
                  glyph={
                    <AppGlyph name={item.label} seed={item.appId} size="dock" />
                  }
                  renderLink={(props) => (
                    <Link
                      to="/app/$appSlug"
                      params={{ appSlug: item.appSlug }}
                      hash={item.entryHash ?? undefined}
                      {...props}
                    />
                  )}
                  onUnpin={() => remove.mutate(item.id)}
                  menuItems={{
                    before: (
                      <Menu.Item
                        leftSection={<IconPencil size={15} stroke={1.7} />}
                        onClick={() => {
                          setEditTarget({ id: item.id, appId: item.appId });
                          setEditLabel(item.label);
                          setEditHash(item.entryHash ?? '');
                        }}
                      >
                        Edit
                      </Menu.Item>
                    ),
                    after: (
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
                    ),
                  }}
                />
              )}
            />
            <DockAddButton label="Pin an app to the dock">
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
              {openable.length > 0 ? <Menu.Divider /> : null}
              <Menu.Item
                leftSection={<IconLayoutGrid size={16} stroke={1.6} />}
                renderRoot={(props) => <Link to="/apps" {...props} />}
              >
                All apps
              </Menu.Item>
              <Menu.Item
                leftSection={<IconSparkles size={16} stroke={1.6} />}
                onClick={goCreateApp}
              >
                New app with Agent
              </Menu.Item>
            </DockAddButton>
          </>
        ) : null}
      </div>

      <Modal
        opened={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit pin"
        centered
      >
        <Stack gap="sm">
          <TextInput
            data-autofocus
            label="Name"
            value={editLabel}
            onChange={(e) => setEditLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitEdit();
              }
            }}
          />
          <AppRouteAutocomplete
            routes={editedManifest?.app?.routes ?? []}
            label="Entry point"
            description="Open the app at a specific page. Leave blank for the app home."
            placeholder="/settings"
            value={editHash}
            onChange={setEditHash}
          />
          <Group justify="flex-end">
            <Button
              type="button"
              loading={update.isPending}
              disabled={!editLabel.trim()}
              onClick={submitEdit}
            >
              Save
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function DockWorkflows({ openItems }: { openItems: readonly DockOpenItem[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: workflows } = useQuery(workflowsQueryOptions);

  const setPin = useMutation({
    mutationFn: (input: { id: string; pinned: boolean }) =>
      setWorkflowPinFn({ data: input }),
    onSuccess: (_res, input) => {
      toast.success(input.pinned ? 'Pinned to the dock' : 'Unpinned');
    },
    // Also after a failure: the Workflow may have been removed elsewhere.
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: workflowsQueryOptions.queryKey,
      }),
  });

  const pinned = (workflows ?? []).filter((w) => w.pinned);
  const candidates = (workflows ?? []).filter((w) => !w.pinned);

  const goCreate = () => {
    toast.info('Create a new workflow by chatting with the Agent');
    void navigate({ to: '/agent' });
  };

  return (
    <div className={classes.group}>
      <span className={classes.groupLabel}>Workflows</span>
      <div className={classes.row}>
        {workflows ? (
          <>
            {pinned.map((w) => (
              <DockItem
                key={w.id}
                label={w.name}
                shape="workflow"
                open={openItems.some(
                  (item) => item.kind === 'workflow' && item.slug === w.slug,
                )}
                glyph={
                  <AppGlyph
                    icon={false}
                    name={w.name}
                    seed={w.id}
                    size="dock"
                  />
                }
                renderLink={(props) => (
                  <Link
                    to="/workflow/$workflowSlug"
                    params={{ workflowSlug: w.slug }}
                    {...props}
                  />
                )}
                onUnpin={() => setPin.mutate({ id: w.id, pinned: false })}
                menuItems={{
                  after: (
                    <Menu.Item
                      leftSection={<IconSettings size={15} stroke={1.7} />}
                      renderRoot={(props) => (
                        <Link
                          to="/workflow/$workflowSlug/manage"
                          params={{ workflowSlug: w.slug }}
                          {...props}
                        />
                      )}
                    >
                      Manage
                    </Menu.Item>
                  ),
                }}
              />
            ))}
            <DockAddButton label="Pin a workflow to the dock" shape="workflow">
              {candidates.length > 0 ? (
                <>
                  <Menu.Label>Pin a workflow</Menu.Label>
                  {candidates.map((w) => (
                    <Menu.Item
                      key={w.id}
                      leftSection={<IconRepeat size={16} stroke={1.6} />}
                      disabled={setPin.isPending}
                      onClick={() => setPin.mutate({ id: w.id, pinned: true })}
                    >
                      <Text size="sm" truncate>
                        {w.name}
                      </Text>
                    </Menu.Item>
                  ))}
                  <Menu.Divider />
                </>
              ) : null}
              <Menu.Item
                leftSection={<IconRepeat size={16} stroke={1.6} />}
                renderRoot={(props) => <Link to="/workflows" {...props} />}
              >
                All workflows
              </Menu.Item>
              <Menu.Item
                leftSection={<IconSparkles size={16} stroke={1.6} />}
                onClick={goCreate}
              >
                New workflow with Agent
              </Menu.Item>
            </DockAddButton>
          </>
        ) : null}
      </div>
    </div>
  );
}
