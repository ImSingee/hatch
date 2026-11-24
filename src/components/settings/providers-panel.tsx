import {
  ActionIcon,
  Autocomplete,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { Claude, OpenAI } from '@lobehub/icons';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { useState } from 'react';
import { Trans } from 'react-i18next';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  IconDotsVertical,
  IconPencil,
  IconPlus,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { providersQueryOptions } from '~queries/agent';
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  updateModel,
  updateProvider,
  type ProviderModel,
  type ProviderWithModels,
} from '~server/providers';
import classes from './providers-panel.module.css';

const API_TYPE_OPTIONS = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Completions' },
];

const PROVIDER_AVATAR_SIZE = 40;

/** Official brand avatar chosen by API protocol: OpenAI for openai-*, Claude
 * for anthropic-messages, a neutral fallback otherwise. */
function ProviderAvatar({ apiType }: { apiType: string }) {
  if (apiType === 'anthropic-messages') {
    return <Claude.Avatar size={PROVIDER_AVATAR_SIZE} />;
  }
  if (apiType.startsWith('openai')) {
    return <OpenAI.Avatar size={PROVIDER_AVATAR_SIZE} type="gpt5" />;
  }
  return (
    <ThemeIcon
      size={PROVIDER_AVATAR_SIZE}
      radius="xl"
      variant="light"
      color="primary"
    >
      <IconRobot size={22} stroke={1.5} />
    </ThemeIcon>
  );
}

const BASE_URL_HINTS: Record<string, PlainTranslationKey> = {
  'anthropic-messages': 'providers.form.baseUrlHint.anthropicMessages',
  'openai-responses': 'providers.form.baseUrlHint.openaiResponses',
  'openai-completions': 'providers.form.baseUrlHint.openaiCompletions',
};

type ProviderFormValues = {
  name: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
};

export function ProviderFormModal({
  opened,
  onClose,
  provider,
}: {
  opened: boolean;
  onClose: () => void;
  provider?: ProviderWithModels;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const editing = Boolean(provider);
  const form = useForm<ProviderFormValues>({
    initialValues: {
      name: provider?.name ?? '',
      apiType: provider?.apiType ?? 'anthropic-messages',
      baseUrl: provider?.baseUrl ?? '',
      apiKey: '',
    },
    validate: {
      // Validation stores catalog keys; fieldError translates them on render.
      name: (v) => (v.trim() ? null : 'providers.form.required'),
      baseUrl: (v) => (v.trim() ? null : 'providers.form.required'),
      apiKey: (v) => (editing || v.trim() ? null : 'providers.form.required'),
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: ProviderFormValues) => {
      if (provider) {
        await updateProvider({
          data: {
            id: provider.id,
            name: values.name,
            apiType: values.apiType as ProviderWithModels['apiType'],
            baseUrl: values.baseUrl,
            apiKey: values.apiKey || undefined,
          },
        });
      } else {
        await createProvider({
          data: {
            name: values.name,
            apiType: values.apiType as ProviderWithModels['apiType'],
            baseUrl: values.baseUrl,
            apiKey: values.apiKey,
          },
        });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });
      toast.success(
        t(
          editing
            ? 'providers.toast.providerUpdated'
            : 'providers.toast.providerAdded',
        ),
      );
      form.reset();
      onClose();
    },
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t(editing ? 'providers.editProvider' : 'providers.addProvider')}
      centered
    >
      <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
        <Stack gap="sm">
          <TextInput
            label={t('common.name')}
            placeholder={t('providers.form.namePlaceholder')}
            {...form.getInputProps('name')}
            error={fieldError(t, form.errors.name)}
          />
          <Select
            label={t('providers.form.apiType')}
            data={API_TYPE_OPTIONS}
            allowDeselect={false}
            {...form.getInputProps('apiType')}
          />
          <TextInput
            label={t('providers.form.baseUrl')}
            placeholder="https://api.example.com"
            description={
              form.values.apiType in BASE_URL_HINTS
                ? t(BASE_URL_HINTS[form.values.apiType])
                : ''
            }
            {...form.getInputProps('baseUrl')}
            error={fieldError(t, form.errors.baseUrl)}
          />
          <TextInput
            label={t('providers.form.apiKey')}
            type="password"
            placeholder={
              editing ? t('providers.form.apiKeyKeepCurrent') : 'sk-...'
            }
            {...form.getInputProps('apiKey')}
            error={fieldError(t, form.errors.apiKey)}
          />
          <Group justify="flex-end" mt="xs">
            <Button type="button" variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {editing ? t('common.save') : t('providers.addProvider')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

type ModelFormValues = {
  kind: ProviderModel['kind'];
  modelId: string;
  name: string;
  description: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
};

const MODEL_KIND_LABELS: Record<ProviderModel['kind'], PlainTranslationKey> = {
  chat: 'providers.model.kind.chat',
  image: 'providers.model.kind.image',
};

type Translate = ReturnType<typeof useI18n>['t'];

/** Form validation stores a catalog key; translate it when rendering. */
function fieldError(t: Translate, error: unknown) {
  return typeof error === 'string' && error
    ? t(error as PlainTranslationKey)
    : undefined;
}

function ModelFormModal({
  opened,
  onClose,
  provider,
  model,
}: {
  opened: boolean;
  onClose: () => void;
  provider: ProviderWithModels;
  model?: ProviderModel;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const editing = Boolean(model);
  const canMakeImages = provider.imageModelSuggestions.length > 0;
  const form = useForm<ModelFormValues>({
    initialValues: {
      kind: model?.kind ?? 'chat',
      modelId: model?.modelId ?? '',
      name: model?.name ?? '',
      description: model?.description ?? '',
      reasoning: model?.reasoning ?? false,
      contextWindow: model?.contextWindow ?? 128000,
      maxTokens: model?.maxTokens ?? 8192,
    },
    validate: {
      modelId: (v) => (v.trim() ? null : 'providers.form.required'),
      description: (v) =>
        Array.from(v.trim()).length > 200
          ? 'providers.model.descriptionTooLong'
          : null,
    },
  });
  const image = form.values.kind === 'image';

  const mutation = useMutation({
    mutationFn: async ({ kind, ...values }: ModelFormValues) => {
      // Display name is optional: fall back to the model ID when left blank.
      const name = values.name.trim() || values.modelId.trim();
      const fields =
        kind === 'image'
          ? {
              modelId: values.modelId,
              name,
              description: values.description,
            }
          : { ...values, name };
      if (model) {
        await updateModel({ data: { id: model.id, kind, ...fields } });
        return;
      }
      await createModel({
        data: { providerId: provider.id, kind, ...fields },
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });
      toast.success(
        t(
          editing
            ? 'providers.toast.modelUpdated'
            : 'providers.toast.modelAdded',
        ),
      );
      form.reset();
      onClose();
    },
  });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t(editing ? 'providers.model.edit' : 'providers.model.add')}
      centered
    >
      <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
        <Stack gap="sm">
          <Select
            label={t('providers.model.category')}
            description={t(
              canMakeImages
                ? image
                  ? 'providers.model.categoryImage'
                  : 'providers.model.categoryChat'
                : 'providers.model.categoryNoImages',
            )}
            allowDeselect={false}
            data={[
              { value: 'chat', label: t(MODEL_KIND_LABELS.chat) },
              {
                value: 'image',
                label: t(MODEL_KIND_LABELS.image),
                disabled: !canMakeImages,
              },
            ]}
            {...form.getInputProps('kind')}
          />
          {image ? (
            <Autocomplete
              label={t('providers.model.modelId')}
              placeholder={provider.imageModelSuggestions[0]}
              description={t('providers.model.modelIdDescription')}
              data={provider.imageModelSuggestions}
              {...form.getInputProps('modelId')}
              error={fieldError(t, form.errors.modelId)}
            />
          ) : (
            <TextInput
              label={t('providers.model.modelId')}
              placeholder="gpt-5.5"
              description={t('providers.model.modelIdDescription')}
              {...form.getInputProps('modelId')}
              error={fieldError(t, form.errors.modelId)}
            />
          )}
          <TextInput
            label={t('providers.model.displayName')}
            description={t('providers.model.displayNameDescription')}
            placeholder={
              form.values.modelId.trim() || (image ? 'GPT Image' : 'GPT-5.5')
            }
            {...form.getInputProps('name')}
          />
          {image ? (
            <Textarea
              label={t('providers.model.bestFor')}
              description={t('providers.model.bestForDescription')}
              placeholder={t('providers.model.bestForPlaceholder')}
              autosize
              minRows={2}
              maxRows={4}
              {...form.getInputProps('description')}
              error={fieldError(t, form.errors.description)}
            />
          ) : null}
          {image ? null : (
            <>
              <Group grow>
                <NumberInput
                  label={t('providers.model.contextWindow')}
                  min={1000}
                  step={1000}
                  thousandSeparator=","
                  {...form.getInputProps('contextWindow')}
                />
                <NumberInput
                  label={t('providers.model.maxTokens')}
                  min={256}
                  step={256}
                  thousandSeparator=","
                  {...form.getInputProps('maxTokens')}
                />
              </Group>
              <Switch
                label={t('providers.model.reasoning')}
                description={t('providers.model.reasoningDescription')}
                {...form.getInputProps('reasoning', { type: 'checkbox' })}
              />
            </>
          )}
          <Group justify="flex-end" mt="xs">
            <Button type="button" variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {editing ? t('common.save') : t('providers.model.add')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function ProviderCard({ provider }: { provider: ProviderWithModels }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [editOpen, editHandlers] = useDisclosure(false);
  // null = closed, 'new' = add model, ProviderModel = edit that model.
  const [modelTarget, setModelTarget] = useState<ProviderModel | 'new' | null>(
    null,
  );

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey });

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

  const removeModel = useMutation({
    mutationFn: (id: string) => deleteModel({ data: { id } }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('providers.toast.modelRemoved'));
    },
  });

  return (
    <div className={classes.provider}>
      <div className={classes.providerHead}>
        <Group className={classes.providerInfo} wrap="nowrap" gap="sm">
          <ProviderAvatar apiType={provider.apiType} />
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
            </Group>
            <Text size="xs" c="dimmed" truncate>
              {provider.baseUrl}
            </Text>
          </Stack>
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Tooltip
            label={t(provider.enabled ? 'common.enabled' : 'common.disabled')}
            withArrow
            position="left"
          >
            <Switch
              checked={provider.enabled}
              onChange={(e) => toggleEnabled.mutate(e.currentTarget.checked)}
              size="sm"
            />
          </Tooltip>
          <Menu position="bottom-end" withArrow shadow="md">
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label={t('providers.card.menu')}
              >
                <IconDotsVertical size={18} stroke={1.6} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={editHandlers.open}>
                {t('providers.editProvider')}
              </Menu.Item>
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
            {provider.models.map((m) => (
              <div key={m.id} className={classes.modelRow}>
                <Group gap="sm" wrap="nowrap" className={classes.modelMain}>
                  <Text size="sm" fw={600} className={classes.modelName}>
                    {m.name}
                  </Text>
                  <Text
                    size="xs"
                    c="dimmed"
                    ff="monospace"
                    truncate
                    visibleFrom="xs"
                    className={classes.modelId}
                  >
                    {m.modelId}
                  </Text>
                </Group>
                <Group gap={2} wrap="nowrap" className={classes.modelActions}>
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    size="sm"
                    aria-label={t('providers.model.edit')}
                    onClick={() => setModelTarget(m)}
                  >
                    <IconPencil size={15} stroke={1.6} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label={t('providers.model.remove')}
                    onClick={() =>
                      modals.openConfirmModal({
                        title: t('providers.model.remove'),
                        centered: true,
                        children: (
                          <Text size="sm">
                            <Trans
                              t={t}
                              i18nKey="providers.model.removeBody"
                              values={{ name: m.name }}
                              components={{ b: <b /> }}
                            />
                          </Text>
                        ),
                        labels: {
                          confirm: t('common.remove'),
                          cancel: t('common.cancel'),
                        },
                        confirmProps: { color: 'red' },
                        onConfirm: () => removeModel.mutate(m.id),
                      })
                    }
                  >
                    <IconTrash size={15} stroke={1.6} />
                  </ActionIcon>
                </Group>
              </div>
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed" className={classes.emptyModels}>
            {t('providers.card.noModels')}
          </Text>
        )}
        <Group mt="xs">
          <Button
            type="button"
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={<IconPlus size={14} stroke={2} />}
            onClick={() => setModelTarget('new')}
          >
            {t('providers.model.add')}
          </Button>
        </Group>
      </div>

      {editOpen && (
        <ProviderFormModal
          opened
          onClose={editHandlers.close}
          provider={provider}
        />
      )}
      <ModelFormModal
        key={modelTarget && modelTarget !== 'new' ? modelTarget.id : 'new'}
        opened={modelTarget !== null}
        onClose={() => setModelTarget(null)}
        provider={provider}
        model={modelTarget && modelTarget !== 'new' ? modelTarget : undefined}
      />
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

  if (providers.length === 0) {
    return (
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
    );
  }

  return (
    <div className={classes.providerList}>
      {providers.map((p) => (
        <ProviderCard key={p.id} provider={p} />
      ))}
    </div>
  );
}
