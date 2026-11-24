import {
  Anchor,
  Button,
  Collapse,
  Group,
  Modal,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
  ActionIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconChevronDown,
  IconChevronRight,
  IconExternalLink,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { ProviderAvatar } from '~components/providers/provider-avatar';
import {
  agentModelChoicesQueryOptions,
  catalogProvidersQueryOptions,
  providersQueryOptions,
} from '~queries/agent';
import type { CatalogProvider } from '~server/model-catalog/types';
import {
  createProvider,
  searchCatalog,
  updateProvider,
  type ProviderWithModels,
} from '~server/providers';
import { ModelSearchInput, type PickedModel } from './model-search-input';
import { formatTokenCount } from './token-count';
import classes from './providers-panel.module.css';

export const API_TYPE_OPTIONS = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-completions', label: 'OpenAI Completions' },
];

type ApiType = ProviderWithModels['apiType'];

const BASE_URL_HINTS: Record<string, PlainTranslationKey> = {
  'anthropic-messages': 'providers.form.baseUrlHint.anthropicMessages',
  'openai-responses': 'providers.form.baseUrlHint.openaiResponses',
  'openai-completions': 'providers.form.baseUrlHint.openaiCompletions',
};

function invalidateProviders(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
    qc.invalidateQueries({ queryKey: agentModelChoicesQueryOptions.queryKey }),
  ]);
}

/** Gallery of catalog presets plus a Custom tile. */
function ProviderGallery({
  onPick,
}: {
  onPick: (preset: CatalogProvider | null) => void;
}) {
  const { t } = useI18n();
  const presets = useQuery(catalogProvidersQueryOptions);
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (presets.data ?? []).filter(
      (preset) =>
        !term ||
        preset.name.toLowerCase().includes(term) ||
        preset.id.includes(term),
    );
  }, [presets.data, search]);

  return (
    <Stack gap="sm">
      <TextInput
        placeholder={t('providers.gallery.search')}
        aria-label={t('providers.gallery.search')}
        leftSection={<IconSearch size={15} stroke={1.7} />}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        data-autofocus
      />
      <ScrollArea.Autosize mah={380} offsetScrollbars>
        <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} spacing="xs">
          {visible.map((preset) => (
            <UnstyledButton
              key={preset.id}
              type="button"
              className={classes.tile}
              onClick={() => onPick(preset)}
            >
              <ProviderAvatar catalogProviderId={preset.id} size={32} />
              <div className={classes.tileText}>
                <Text size="sm" fw={700} truncate>
                  {preset.name}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {new URL(preset.baseUrl).host}
                </Text>
              </div>
            </UnstyledButton>
          ))}
          <UnstyledButton
            type="button"
            className={classes.tile}
            onClick={() => onPick(null)}
          >
            <ProviderAvatar size={32} />
            <div className={classes.tileText}>
              <Text size="sm" fw={700}>
                {t('providers.gallery.custom')}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {t('providers.gallery.customDescription')}
              </Text>
            </div>
          </UnstyledButton>
        </SimpleGrid>
      </ScrollArea.Autosize>
    </Stack>
  );
}

/** The models a new provider starts with, one row each. */
function PickedModelList({
  models,
  onRemove,
}: {
  models: PickedModel[];
  onRemove: (modelId: string) => void;
}) {
  const { t } = useI18n();
  if (!models.length) return null;
  return (
    <div className={classes.pickedList}>
      {models.map((model) => (
        <div key={model.modelId} className={classes.modelRow}>
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
            {model.contextWindow ? (
              <span className={classes.chip}>
                {formatTokenCount(model.contextWindow)}
              </span>
            ) : null}
          </Group>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={t('providers.model.removeNamed', { name: model.name })}
            onClick={() => onRemove(model.modelId)}
          >
            <IconX size={14} stroke={1.8} />
          </ActionIcon>
        </div>
      ))}
    </div>
  );
}

type FormValues = {
  name: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
  catalogProviderId: string | null;
};

/** Fill the recommended models with their catalog names and sizes. */
function useRecommended(preset: CatalogProvider | null) {
  return useQuery({
    queryKey: ['agent', 'catalog', 'recommended', preset?.id],
    enabled: preset !== null && preset.recommended.length > 0,
    queryFn: async (): Promise<PickedModel[]> => {
      const result = await searchCatalog({
        data: { providerId: preset!.id, limit: 100 },
      });
      const byId = new Map(result.models.map((hit) => [hit.model.id, hit]));
      return preset!.recommended.map((modelId) => {
        const hit = byId.get(modelId);
        return {
          modelId,
          name: hit?.model.name ?? modelId,
          kind: hit?.model.kind ?? 'chat',
          catalogRef: `${preset!.id}/${modelId}`,
          contextWindow: hit?.model.contextWindow,
        };
      });
    },
  });
}

function NewProviderForm({
  preset,
  onBack,
  onDone,
}: {
  preset: CatalogProvider | null;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [advanced, advancedHandlers] = useDisclosure(false);
  const recommended = useRecommended(preset);
  // null = still the recommended set; edits make it explicit.
  const [models, setModels] = useState<PickedModel[] | null>(null);
  const picked = useMemo(
    () => models ?? recommended.data ?? [],
    [models, recommended.data],
  );
  const presets = useQuery(catalogProvidersQueryOptions);
  const form = useForm<FormValues>({
    initialValues: {
      name: preset?.name ?? '',
      apiType: preset?.apiType ?? 'openai-completions',
      baseUrl: preset?.baseUrl ?? '',
      apiKey: '',
      catalogProviderId: preset?.id ?? null,
    },
    validate: {
      name: (v) => (v.trim() ? null : t('providers.form.required')),
      baseUrl: (v) => (v.trim() ? null : t('providers.form.required')),
      apiKey: (v) => (v.trim() ? null : t('providers.form.required')),
    },
  });

  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      createProvider({
        data: {
          catalogProviderId: values.catalogProviderId,
          name: values.name,
          apiType: values.apiType as ApiType,
          baseUrl: values.baseUrl,
          apiKey: values.apiKey,
          models: picked.map((model) => ({
            modelId: model.modelId,
            kind: model.kind,
          })),
        },
      }),
    onSuccess: async () => {
      await invalidateProviders(qc);
      toast.success(t('providers.toast.providerAdded'));
      onDone();
    },
  });

  const exclude = useMemo(
    () => new Set(picked.map((model) => model.modelId)),
    [picked],
  );
  const scope = form.values.catalogProviderId;

  const connection = (
    <Stack gap="sm">
      <Group grow align="flex-start">
        <TextInput
          label={t('common.name')}
          placeholder={t('providers.form.namePlaceholder')}
          data-autofocus={preset === null || undefined}
          {...form.getInputProps('name')}
        />
        <Select
          label={t('providers.form.apiType')}
          data={API_TYPE_OPTIONS}
          allowDeselect={false}
          {...form.getInputProps('apiType')}
        />
      </Group>
      <TextInput
        label={t('providers.form.baseUrl')}
        placeholder="https://api.example.com/v1"
        description={
          BASE_URL_HINTS[form.values.apiType]
            ? t(BASE_URL_HINTS[form.values.apiType])
            : undefined
        }
        {...form.getInputProps('baseUrl')}
      />
    </Stack>
  );

  return (
    <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
      <Stack gap="sm">
        {preset === null ? connection : null}
        <TextInput
          label={t('providers.form.apiKey')}
          type="password"
          placeholder="sk-..."
          description={
            <>
              {preset?.apiKeyUrl ? (
                <>
                  <Anchor
                    href={preset.apiKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    size="xs"
                  >
                    {t('providers.form.getApiKey')}{' '}
                    <IconExternalLink size={11} stroke={1.8} />
                  </Anchor>{' '}
                  ·{' '}
                </>
              ) : null}
              {t('providers.form.apiKeyStored')}
            </>
          }
          data-autofocus={preset !== null || undefined}
          {...form.getInputProps('apiKey')}
        />
        {preset === null ? (
          <Select
            label={t('providers.form.catalogLink')}
            description={t('providers.form.catalogLinkDescription')}
            placeholder={t('providers.form.catalogLinkNone')}
            clearable
            searchable
            selectFirstOptionOnChange
            data={(presets.data ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            {...form.getInputProps('catalogProviderId')}
          />
        ) : null}
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {t('providers.form.models')}
          </Text>
          <ModelSearchInput
            catalogProviderId={scope}
            exclude={exclude}
            onPick={(model) => setModels([...picked, model])}
          />
          <Text size="xs" c="dimmed">
            {t('providers.form.modelsHint')}
          </Text>
          <PickedModelList
            models={picked}
            onRemove={(modelId) =>
              setModels(picked.filter((model) => model.modelId !== modelId))
            }
          />
        </Stack>
        {preset === null ? null : (
          <>
            <UnstyledButton
              type="button"
              className={classes.disclosure}
              onClick={advancedHandlers.toggle}
              aria-expanded={advanced}
            >
              {advanced ? (
                <IconChevronDown size={14} stroke={2} />
              ) : (
                <IconChevronRight size={14} stroke={2} />
              )}
              <span>{t('providers.form.advanced')}</span>
            </UnstyledButton>
            <Collapse expanded={advanced}>{connection}</Collapse>
          </>
        )}
        <Group justify="flex-end" mt="xs">
          <Button type="button" variant="default" onClick={onBack}>
            {t('providers.form.back')}
          </Button>
          <Button
            type="submit"
            loading={mutation.isPending}
            leftSection={<IconPlus size={15} stroke={1.8} />}
          >
            {t('providers.addProvider')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function EditProviderForm({
  provider,
  onClose,
}: {
  provider: ProviderWithModels;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const presets = useQuery(catalogProvidersQueryOptions);
  const form = useForm<FormValues>({
    initialValues: {
      name: provider.name,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: '',
      catalogProviderId: provider.catalogProviderId,
    },
    validate: {
      name: (v) => (v.trim() ? null : t('providers.form.required')),
      baseUrl: (v) => (v.trim() ? null : t('providers.form.required')),
      apiKey: (v, values) =>
        v.trim()
          ? null
          : !provider.hasApiKey
            ? t('providers.form.apiKeyNeeded')
            : values.baseUrl.trim().replace(/\/+$/, '') !== provider.baseUrl ||
                values.apiType !== provider.apiType
              ? t('providers.form.apiKeyForEndpoint')
              : null,
    },
  });
  const mutation = useMutation({
    mutationFn: (values: FormValues) =>
      updateProvider({
        data: {
          id: provider.id,
          name: values.name,
          apiType: values.apiType as ApiType,
          baseUrl: values.baseUrl,
          apiKey: values.apiKey || undefined,
          catalogProviderId: values.catalogProviderId,
        },
      }),
    onSuccess: async () => {
      await invalidateProviders(qc);
      toast.success(t('providers.toast.providerUpdated'));
      onClose();
    },
  });

  return (
    <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
      <Stack gap="sm">
        <TextInput
          label={t('common.name')}
          placeholder={t('providers.form.namePlaceholder')}
          data-autofocus
          {...form.getInputProps('name')}
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
            BASE_URL_HINTS[form.values.apiType]
              ? t(BASE_URL_HINTS[form.values.apiType])
              : undefined
          }
          {...form.getInputProps('baseUrl')}
        />
        <TextInput
          label={t('providers.form.apiKey')}
          type="password"
          placeholder={
            provider.hasApiKey
              ? t('providers.form.apiKeyKeepCurrent')
              : 'sk-...'
          }
          {...form.getInputProps('apiKey')}
        />
        <Select
          label={t('providers.form.catalogLink')}
          description={t('providers.form.catalogLinkDescription')}
          placeholder={t('providers.form.catalogLinkNone')}
          clearable
          searchable
          selectFirstOptionOnChange
          data={(presets.data ?? []).map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          {...form.getInputProps('catalogProviderId')}
        />
        <Group justify="flex-end" mt="xs">
          <Button type="button" variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function ProviderFormModal({
  opened,
  onClose,
  provider,
}: {
  opened: boolean;
  onClose: () => void;
  provider?: ProviderWithModels;
}) {
  // undefined = choosing from the gallery; null = Custom.
  const { t } = useI18n();
  const [preset, setPreset] = useState<CatalogProvider | null | undefined>(
    undefined,
  );
  const title = provider
    ? t('providers.editProvider')
    : preset === undefined
      ? t('providers.addProvider')
      : preset === null
        ? t('providers.addCustom')
        : t('providers.addNamed', { name: preset.name });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      centered
      size={provider || preset !== undefined ? 'md' : 'lg'}
    >
      {provider ? (
        <EditProviderForm provider={provider} onClose={onClose} />
      ) : preset === undefined ? (
        <ProviderGallery onPick={setPreset} />
      ) : (
        <NewProviderForm
          key={preset?.id ?? 'custom'}
          preset={preset}
          onBack={() => setPreset(undefined)}
          onDone={onClose}
        />
      )}
    </Modal>
  );
}
