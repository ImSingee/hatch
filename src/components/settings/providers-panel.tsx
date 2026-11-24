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
  IconPencil,
  IconPlugConnected,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { ProviderAvatar } from '~components/providers/provider-avatar';
import { formatExact, formatRelative } from '~/lib/format';
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

function ModelRow({
  provider,
  model,
  onEdit,
}: {
  provider: ProviderWithModels;
  model: ProviderModel;
  onEdit: () => void;
}) {
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
      toast.success('Model removed');
    },
  });

  return (
    <div
      className={classes.modelRow}
      data-disabled={!model.enabled || undefined}
    >
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
        {model.chat?.overridden.length ? (
          <Tooltip label="Some values differ from the catalog" withArrow>
            <Badge variant="light" size="sm">
              Custom
            </Badge>
          </Tooltip>
        ) : null}
      </Group>
      <Group gap={2} wrap="nowrap" className={classes.modelActions}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Edit ${model.name}`}
          onClick={onEdit}
        >
          <IconPencil size={15} stroke={1.6} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          aria-label={`Remove ${model.name}`}
          onClick={() =>
            modals.openConfirmModal({
              title: 'Remove model',
              centered: true,
              children: (
                <Text size="sm">
                  Remove <b>{model.name}</b>? Chats using it will switch to
                  another model.
                </Text>
              ),
              labels: { confirm: 'Remove', cancel: 'Cancel' },
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
        aria-label={`${model.enabled ? 'Disable' : 'Enable'} ${model.name}`}
      />
    </div>
  );
}

function AddModel({ provider }: { provider: ProviderWithModels }) {
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
        Add model
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
        Done
      </Button>
    </Group>
  );
}

function ProviderCard({ provider }: { provider: ProviderWithModels }) {
  const qc = useQueryClient();
  const invalidate = useInvalidateProviders();
  const [editOpen, editHandlers] = useDisclosure(false);
  const [editing, setEditing] = useState<ProviderModel | null>(null);

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
      toast.success('Provider removed');
    },
  });

  const test = useMutation({
    mutationFn: () => testProvider({ data: { id: provider.id } }),
    onSuccess: (result) => {
      if (result.ok)
        toast.success(
          `${provider.name} answered in ${(result.latencyMs / 1000).toFixed(1)} s`,
        );
      else
        toast.error(`${provider.name} failed: ${result.error ?? 'no details'}`);
    },
  });

  return (
    <div className={classes.provider}>
      <div className={classes.providerHead}>
        <Group className={classes.providerInfo} wrap="nowrap" gap="sm">
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
                  Off
                </Badge>
              )}
              {provider.hasApiKey ? null : (
                <Badge variant="light" color="yellow" size="sm">
                  No API key
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
            label={provider.enabled ? 'Enabled' : 'Disabled'}
            withArrow
            position="left"
          >
            <Switch
              checked={provider.enabled}
              onChange={(e) => toggleEnabled.mutate(e.currentTarget.checked)}
              size="sm"
              aria-label={`${provider.enabled ? 'Disable' : 'Enable'} ${provider.name}`}
            />
          </Tooltip>
          <Menu position="bottom-end" withArrow shadow="md">
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Provider menu"
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
                Edit provider
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlugConnected size={15} stroke={1.6} />}
                disabled={!provider.hasApiKey || test.isPending}
                onClick={() => test.mutate()}
              >
                Test connection
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={15} stroke={1.6} />}
                onClick={() =>
                  modals.openConfirmModal({
                    title: 'Remove provider',
                    centered: true,
                    children: (
                      <Text size="sm">
                        Remove <b>{provider.name}</b> and its models? Chats
                        using it will switch to another model.
                      </Text>
                    ),
                    labels: { confirm: 'Remove', cancel: 'Cancel' },
                    confirmProps: { color: 'red' },
                    onConfirm: () => removeProvider.mutate(),
                  })
                }
              >
                Remove provider
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </div>

      <div className={classes.models}>
        {provider.models.length > 0 ? (
          <Stack gap={2}>
            {provider.models.map((m) => (
              <ModelRow
                key={m.id}
                provider={provider}
                model={m}
                onEdit={() => setEditing(m)}
              />
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" className={classes.emptyModels}>
            No models yet — add one to use this provider.
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
        toast.success('Model catalog updated');
        await qc.invalidateQueries({ queryKey: ['agent'] });
      } else if (result.outcome === 'unchanged')
        toast.info('The model catalog is up to date');
      else
        toast.error(result.status.lastError ?? 'Could not update the catalog');
    },
    onError: (error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: (input: { autoUpdate?: boolean; sourceUrl?: string | null }) =>
      updateModelCatalogSettings({ data: input }),
    onSuccess: (next) => {
      setStatus(next);
      toast.success('Catalog settings saved');
    },
  });
  if (!status.data) return null;
  const data = status.data;
  const changed = data.lastUpdatedAt ?? data.generatedAt;

  return (
    <div className={classes.catalogBar}>
      <div className={classes.catalogText}>
        <Text size="sm" fw={700}>
          Model catalog ·{' '}
          <Tooltip label={formatExact(changed)} withArrow>
            <span>updated {formatRelative(changed)}</span>
          </Tooltip>
        </Text>
        <Text size="xs" c={data.lastError ? 'red' : 'dimmed'}>
          {data.lastError
            ? `Last check failed: ${data.lastError}`
            : `${data.modelCount.toLocaleString('en-US')} models from aidy-models${
                data.lastCheckedAt
                  ? ` · checked ${formatRelative(data.lastCheckedAt)}`
                  : ''
              } · ${data.autoUpdate ? 'updates automatically' : 'automatic updates off'}`}
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
          Check now
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
              aria-label="Catalog settings"
            >
              <IconAdjustments size={17} stroke={1.6} />
            </ActionIcon>
          </Popover.Target>
          <Popover.Dropdown>
            <Stack gap="sm">
              <Switch
                label="Update automatically"
                description="Checks aidy-models every few hours. Turn off for offline or controlled installs."
                checked={data.autoUpdate}
                onChange={(event) =>
                  save.mutate({ autoUpdate: event.currentTarget.checked })
                }
              />
              <TextInput
                label="Source URL"
                description="An https mirror of aidy-models' models.json. Blank uses GitHub."
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
                  Save source
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
  const { data: providers } = useSuspenseQuery(providersQueryOptions);

  return (
    <Stack gap="md">
      <CatalogStatus />
      {providers.length === 0 ? (
        <Stack align="center" gap="xs" py={64} px="md">
          <ThemeIcon size={52} radius="xl" variant="light" color="primary">
            <IconRobot size={26} stroke={1.5} />
          </ThemeIcon>
          <Text fw={700} mt="xs">
            No providers yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            Pick a provider such as Anthropic, OpenAI or OpenRouter, or connect
            any compatible endpoint, so the Agent can start building apps.
          </Text>
          <Button
            type="button"
            mt="md"
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={onAddProvider}
          >
            Add provider
          </Button>
        </Stack>
      ) : (
        <div className={classes.providerList}>
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}
        </div>
      )}
    </Stack>
  );
}
