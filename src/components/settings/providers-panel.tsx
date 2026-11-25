import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  Popover,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconAdjustments,
  IconDotsVertical,
  IconGripVertical,
  IconPencil,
  IconPlugConnected,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { useErrorText, useI18n } from '~i18n';
import {
  DRAG_HANDLE_ATTRIBUTE,
  SortableList,
  sortByIds,
  type SortableItemControls,
} from '~components/desk/sortable-list';
import { useSerialSave } from '~components/desk/use-serial-save';
import { ProviderAvatar } from '~components/providers/provider-avatar';
import { formatExact, formatRelativeTime } from '~/lib/format';
import {
  agentModelChoicesQueryOptions,
  catalogStatusQueryOptions,
  providersQueryOptions,
} from '~queries/agent';
import {
  createModel,
  deleteModel,
  deleteProvider,
  refreshCatalog,
  reorderModels,
  reorderProviders,
  testProvider,
  updateModel,
  updateModelCatalogSettings,
  updateProvider,
  type ProviderModel,
  type ProviderWithModels,
} from '~server/providers';
import { ModelFormModal } from './model-form-modal';
import { ModelSearchInput } from './model-search-input';
import { ProviderFormModal } from './provider-form-modal';
import { formatTokenCount } from './token-count';
import classes from './providers-panel.module.css';

export { ProviderFormModal };

function useInvalidateProviders() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
      qc.invalidateQueries({
        queryKey: agentModelChoicesQueryOptions.queryKey,
      }),
    ]);
}

/**
 * Grip that drags its row; with focus, ArrowUp and ArrowDown move the row
 * one place instead.
 */
function DragHandle({
  name,
  controls,
}: {
  name: string;
  controls: SortableItemControls;
}) {
  const { t } = useI18n();
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size="sm"
      className={classes.dragHandle}
      aria-label={t('providers.reorderNamed', { name })}
      {...{ [DRAG_HANDLE_ATTRIBUTE]: '' }}
      onKeyDown={(event) => {
        const delta =
          event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (!delta) return;
        event.preventDefault();
        controls.move(delta);
      }}
    >
      <IconGripVertical size={15} stroke={1.6} />
    </ActionIcon>
  );
}

/**
 * Persist a drag order. The providers cache takes each new order at once;
 * saves of one list go out one at a time (see `useSerialSave`) so a quick
 * second move is never overwritten by the first save landing late. The
 * cache refetches once the list is saved, which also undoes a failed save.
 */
function useReorder<T>(
  save: (ids: string[]) => Promise<T>,
  apply: (
    providers: ProviderWithModels[],
    ids: string[],
  ) => ProviderWithModels[],
) {
  const qc = useQueryClient();
  const invalidate = useInvalidateProviders();
  // The mutation only reports a failed save through the global error toast.
  const { mutateAsync } = useMutation({ mutationFn: save });
  const submit = useSerialSave(mutateAsync, invalidate);
  return (ids: string[]) => {
    void qc.cancelQueries({ queryKey: providersQueryOptions.queryKey });
    qc.setQueryData<ProviderWithModels[]>(
      providersQueryOptions.queryKey,
      (old) => (old ? apply(old, ids) : old),
    );
    submit(ids);
  };
}

function ModelRow({
  provider,
  model,
  onEdit,
  controls,
}: {
  provider: ProviderWithModels;
  model: ProviderModel;
  onEdit: () => void;
  controls: SortableItemControls;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const invalidate = useInvalidateProviders();
  const toggle = useMutation({
    mutationKey: ['model-enabled', model.id],
    mutationFn: (enabled: boolean) =>
      updateModel({ data: { id: model.id, enabled } }),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: providersQueryOptions.queryKey });
      const previous = qc.getQueryData<ProviderWithModels[]>(
        providersQueryOptions.queryKey,
      );
      qc.setQueryData<ProviderWithModels[]>(
        providersQueryOptions.queryKey,
        (old) =>
          old?.map((p) =>
            p.id === provider.id
              ? {
                  ...p,
                  models: p.models.map((m) =>
                    m.id === model.id ? { ...m, enabled } : m,
                  ),
                }
              : p,
          ),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous)
        qc.setQueryData(providersQueryOptions.queryKey, context.previous);
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ['model-enabled', model.id] }) === 1)
        void invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteModel({ data: { id: model.id } }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('providers.toast.modelRemoved'));
    },
  });

  return (
    <div
      className={classes.modelRow}
      data-disabled={!model.enabled || undefined}
    >
      <DragHandle name={model.name} controls={controls} />
      <Group gap="sm" wrap="nowrap" className={classes.modelMain}>
        <Text size="sm" fw={600} className={classes.modelName}>
          {model.name}
        </Text>
        <Text
          size="xs"
          c="dimmed"
          ff="monospace"
          truncate
          visibleFrom="xs"
          className={classes.modelId}
        >
          {model.modelId}
        </Text>
        {model.chat ? (
          <span className={classes.chip}>
            {formatTokenCount(model.chat.contextWindow)}
          </span>
        ) : null}
        {!model.inCatalog || model.chat?.overridden.length ? (
          <Tooltip
            label={t(
              model.inCatalog
                ? 'providers.model.customTooltip'
                : 'providers.model.notInCatalogTooltip',
            )}
            withArrow
          >
            <Badge variant="light" size="sm">
              {t('providers.model.custom')}
            </Badge>
          </Tooltip>
        ) : null}
      </Group>
      <Group gap={2} wrap="nowrap" className={classes.modelActions}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={t('providers.model.editNamed', { name: model.name })}
          onClick={onEdit}
        >
          <IconPencil size={15} stroke={1.6} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          aria-label={t('providers.model.removeNamed', { name: model.name })}
          onClick={() =>
            modals.openConfirmModal({
              title: t('providers.model.remove'),
              centered: true,
              children: (
                <Text size="sm">
                  <Trans
                    t={t}
                    i18nKey="providers.model.removeBody"
                    values={{ name: model.name }}
                    components={{ b: <b /> }}
                  />
                </Text>
              ),
              labels: {
                confirm: t('common.remove'),
                cancel: t('common.cancel'),
              },
              confirmProps: { color: 'red' },
              onConfirm: () => remove.mutate(),
            })
          }
        >
          <IconTrash size={15} stroke={1.6} />
        </ActionIcon>
      </Group>
      <Switch
        size="xs"
        checked={model.enabled}
        onChange={(event) => toggle.mutate(event.currentTarget.checked)}
        aria-label={t(
          model.enabled
            ? 'providers.model.disableNamed'
            : 'providers.model.enableNamed',
          { name: model.name },
        )}
      />
    </div>
  );
}

function AddModel({ provider }: { provider: ProviderWithModels }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateProviders();
  const add = useMutation({
    mutationFn: (input: {
      modelId: string;
      kind: 'chat' | 'image';
      catalogRef: string | null;
    }) =>
      createModel({
        data: {
          providerId: provider.id,
          kind: input.kind,
          modelId: input.modelId,
          // A catalog pick names its entry; anything else is matched by id.
          ...(input.catalogRef ? { catalogRef: input.catalogRef } : {}),
        },
      }),
    onSuccess: async () => {
      await invalidate();
    },
  });
  const exclude = useMemo(
    () => new Set(provider.models.map((model) => model.modelId)),
    [provider.models],
  );

  if (!open)
    return (
      <Button
        type="button"
        size="xs"
        variant="subtle"
        color="gray"
        leftSection={<IconPlus size={14} stroke={2} />}
        onClick={() => setOpen(true)}
      >
        {t('providers.model.add')}
      </Button>
    );
  return (
    <Group gap="xs" wrap="nowrap" className={classes.addModel}>
      <div className={classes.addModelInput}>
        <ModelSearchInput
          catalogProviderId={provider.catalogProviderId}
          providerId={provider.hasApiKey ? provider.id : undefined}
          exclude={exclude}
          focusOnMount
          onPick={(model) =>
            add.mutate({
              modelId: model.modelId,
              // Image ids only fit providers that can make images.
              kind:
                model.kind === 'image' && provider.canGenerateImages
                  ? 'image'
                  : 'chat',
              catalogRef: model.catalogRef,
            })
          }
        />
      </div>
      <Button
        type="button"
        size="xs"
        variant="subtle"
        color="gray"
        onClick={() => setOpen(false)}
      >
        {t('common.done')}
      </Button>
    </Group>
  );
}

function ProviderCard({
  provider,
  controls,
}: {
  provider: ProviderWithModels;
  controls: SortableItemControls;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const invalidate = useInvalidateProviders();
  const [editOpen, editHandlers] = useDisclosure(false);
  const [editing, setEditing] = useState<ProviderModel | null>(null);
  const reorder = useReorder(
    (modelIds) =>
      reorderModels({ data: { providerId: provider.id, modelIds } }),
    (providers, ids) =>
      providers.map((p) =>
        p.id === provider.id
          ? { ...p, models: sortByIds(p.models, ids) ?? p.models }
          : p,
      ),
  );

  const toggleEnabled = useMutation({
    mutationKey: ['provider-enabled', provider.id],
    mutationFn: (enabled: boolean) =>
      updateProvider({ data: { id: provider.id, enabled } }),
    // Flip the switch immediately; roll back if the server rejects it (the
    // global mutation error toast reports the failure).
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: providersQueryOptions.queryKey });
      const previous = qc.getQueryData<ProviderWithModels[]>(
        providersQueryOptions.queryKey,
      );
      qc.setQueryData<ProviderWithModels[]>(
        providersQueryOptions.queryKey,
        (old) =>
          old?.map((p) => (p.id === provider.id ? { ...p, enabled } : p)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) {
        qc.setQueryData(providersQueryOptions.queryKey, context.previous);
      }
    },
    // Only refetch once the LAST in-flight toggle settles: an earlier
    // toggle's refetch would otherwise overwrite a newer optimistic flip.
    onSettled: () => {
      if (
        qc.isMutating({ mutationKey: ['provider-enabled', provider.id] }) === 1
      ) {
        void invalidate();
      }
    },
  });

  const removeProvider = useMutation({
    mutationFn: () => deleteProvider({ data: { id: provider.id } }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('providers.toast.providerRemoved'));
    },
  });

  const test = useMutation({
    mutationFn: () => testProvider({ data: { id: provider.id } }),
    onSuccess: (result) => {
      if (result.ok)
        toast.success(
          t('providers.test.ok', {
            name: provider.name,
            seconds: (result.latencyMs / 1000).toFixed(1),
          }),
        );
      else
        toast.error(
          t('providers.test.failed', {
            name: provider.name,
            error: result.error ?? t('providers.test.noDetails'),
          }),
        );
    },
  });

  return (
    <div className={classes.provider}>
      <div className={classes.providerHead}>
        <Group className={classes.providerInfo} wrap="nowrap" gap="sm">
          <DragHandle name={provider.name} controls={controls} />
          <ProviderAvatar
            catalogProviderId={provider.catalogProviderId}
            apiType={provider.apiType}
          />
          <Stack gap={3} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Text fw={700} truncate>
                {provider.name}
              </Text>
              {provider.enabled ? null : (
                <Badge variant="default" size="sm">
                  {t('providers.card.off')}
                </Badge>
              )}
              {provider.hasApiKey ? null : (
                <Badge variant="light" color="yellow" size="sm">
                  {t('providers.card.noApiKey')}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" truncate>
              {provider.baseUrl}
            </Text>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Tooltip
            label={
              provider.enabled ? t('common.enabled') : t('common.disabled')
            }
            withArrow
            position="left"
          >
            <Switch
              checked={provider.enabled}
              onChange={(e) => toggleEnabled.mutate(e.currentTarget.checked)}
              size="sm"
              aria-label={t(
                provider.enabled
                  ? 'providers.card.disableNamed'
                  : 'providers.card.enableNamed',
                { name: provider.name },
              )}
            />
          </Tooltip>
          <Menu position="bottom-end" withArrow shadow="md">
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t('providers.card.menu')}
                loading={test.isPending}
              >
                <IconDotsVertical size={18} stroke={1.6} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconPencil size={15} stroke={1.6} />}
                onClick={editHandlers.open}
              >
                {t('providers.editProvider')}
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlugConnected size={15} stroke={1.6} />}
                disabled={!provider.hasApiKey || test.isPending}
                onClick={() => test.mutate()}
              >
                {t('providers.card.test')}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={15} stroke={1.6} />}
                onClick={() =>
                  modals.openConfirmModal({
                    title: t('providers.removeProvider'),
                    centered: true,
                    children: (
                      <Text size="sm">
                        <Trans
                          t={t}
                          i18nKey="providers.removeProviderBody"
                          values={{ name: provider.name }}
                          components={{ b: <b /> }}
                        />
                      </Text>
                    ),
                    labels: {
                      confirm: t('common.remove'),
                      cancel: t('common.cancel'),
                    },
                    confirmProps: { color: 'red' },
                    onConfirm: () => removeProvider.mutate(),
                  })
                }
              >
                {t('providers.removeProvider')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </div>

      <div className={classes.models}>
        {provider.models.length > 0 ? (
          <Stack gap={2}>
            <SortableList
              handle
              items={provider.models}
              onReorder={(ids) => reorder(ids)}
              renderItem={(m, modelControls) => (
                <ModelRow
                  provider={provider}
                  model={m}
                  onEdit={() => setEditing(m)}
                  controls={modelControls}
                />
              )}
            />
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" className={classes.emptyModels}>
            {t('providers.card.noModels')}
          </Text>
        )}
        <div className={classes.providerFoot}>
          <AddModel provider={provider} />
        </div>
      </div>

      {editOpen && (
        <ProviderFormModal
          opened
          onClose={editHandlers.close}
          provider={provider}
        />
      )}
      {editing ? (
        <ModelFormModal
          key={editing.id}
          opened
          onClose={() => setEditing(null)}
          provider={provider}
          model={editing}
        />
      ) : null}
    </div>
  );
}

/** Where the model catalog comes from and when it last changed. */
function CatalogStatus() {
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const status = useQuery(catalogStatusQueryOptions);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const setStatus = (next: NonNullable<typeof status.data>) =>
    qc.setQueryData(catalogStatusQueryOptions.queryKey, next);
  const refresh = useMutation({
    mutationFn: () => refreshCatalog(),
    meta: { errorToast: false },
    onSuccess: async (result) => {
      setStatus(result.status);
      if (result.outcome === 'updated') {
        toast.success(t('providers.catalog.updated'));
        await qc.invalidateQueries({ queryKey: ['agent'] });
      } else if (result.outcome === 'unchanged')
        toast.info(t('providers.catalog.upToDate'));
      else
        toast.error(
          result.status.lastError ?? t('providers.catalog.updateFailed'),
        );
    },
    onError: (error) =>
      toast.error(errorText(error, 'providers.catalog.updateFailed')),
  });
  const save = useMutation({
    mutationFn: (input: { autoUpdate?: boolean; sourceUrl?: string | null }) =>
      updateModelCatalogSettings({ data: input }),
    onSuccess: (next) => {
      setStatus(next);
      toast.success(t('providers.catalog.saved'));
    },
  });
  if (!status.data) return null;
  const data = status.data;
  const changed = data.lastUpdatedAt ?? data.generatedAt;

  return (
    <div className={classes.catalogBar}>
      <div className={classes.catalogText}>
        <Tooltip label={formatExact(changed)} withArrow>
          <Text size="sm" fw={700}>
            {t('providers.catalog.title', {
              time: formatRelativeTime(changed, locale),
            })}
          </Text>
        </Tooltip>
        <Text size="xs" c={data.lastError ? 'red' : 'dimmed'}>
          {data.lastError
            ? t('providers.catalog.lastError', { error: data.lastError })
            : [
                t('providers.catalog.models', { count: data.modelCount }),
                data.lastCheckedAt
                  ? t('providers.catalog.checked', {
                      time: formatRelativeTime(data.lastCheckedAt, locale),
                    })
                  : null,
                data.autoUpdate
                  ? t('providers.catalog.autoOn')
                  : t('providers.catalog.autoOff'),
              ]
                .filter(Boolean)
                .join(' · ')}
        </Text>
      </div>
      <Group gap={4} wrap="nowrap">
        <Button
          type="button"
          size="xs"
          variant="subtle"
          leftSection={<IconRefresh size={14} stroke={1.8} />}
          loading={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {t('providers.catalog.checkNow')}
        </Button>
        <Popover
          position="bottom-end"
          shadow="md"
          width={320}
          withArrow
          onOpen={() => setSourceUrl(data.sourceUrl ?? '')}
        >
          <Popover.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label={t('providers.catalog.settings')}
            >
              <IconAdjustments size={17} stroke={1.6} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Switch
                label={t('providers.catalog.autoUpdate')}
                description={t('providers.catalog.autoUpdateDescription')}
                checked={data.autoUpdate}
                onChange={(event) =>
                  save.mutate({ autoUpdate: event.currentTarget.checked })
                }
              />
              <TextInput
                label={t('providers.catalog.sourceUrl')}
                description={t('providers.catalog.sourceUrlDescription')}
                placeholder={data.effectiveSourceUrl}
                value={sourceUrl ?? ''}
                onChange={(event) => setSourceUrl(event.currentTarget.value)}
              />
              <Group justify="flex-end">
                <Button
                  type="button"
                  size="xs"
                  loading={save.isPending}
                  disabled={(sourceUrl ?? '') === (data.sourceUrl ?? '')}
                  onClick={() =>
                    save.mutate({ sourceUrl: sourceUrl?.trim() || null })
                  }
                >
                  {t('providers.catalog.saveSource')}
                </Button>
              </Group>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </Group>
    </div>
  );
}

export function ProvidersPanel({
  onAddProvider,
}: {
  onAddProvider: () => void;
}) {
  const { t } = useI18n();
  const { data: providers } = useSuspenseQuery(providersQueryOptions);
  const reorder = useReorder(
    (providerIds) => reorderProviders({ data: { providerIds } }),
    (list, ids) => sortByIds(list, ids) ?? list,
  );

  return (
    <Stack gap="md">
      <CatalogStatus />
      {providers.length === 0 ? (
        <Stack align="center" gap="xs" py={64} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="primary">
            <IconRobot size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={700} mt="xs">
            {t('providers.empty.title')}
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            {t('providers.empty.body')}
          </Text>
          <Button
            type="button"
            mt="md"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={onAddProvider}
          >
            {t('providers.addProvider')}
          </Button>
        </Stack>
      ) : (
        <div className={classes.providerList}>
          <SortableList
            handle
            items={providers}
            onReorder={(ids) => reorder(ids)}
            renderItem={(p, controls) => (
              <ProviderCard provider={p} controls={controls} />
            )}
          />
        </div>
      )}
    </Stack>
  );
}
