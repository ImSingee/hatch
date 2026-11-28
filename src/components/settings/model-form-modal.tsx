import {
  Anchor,
  Autocomplete,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  FALLBACK_CONTEXT_WINDOW,
  resolveLimits,
  resolveNativeWebSearch,
  supportsNativeWebSearch,
  type CatalogLimits,
} from '~/lib/model-limits';
import { type PlainTranslationKey, useI18n } from '~i18n';
import {
  agentModelChoicesQueryOptions,
  providersQueryOptions,
} from '~queries/agent';
import {
  updateModel,
  type ProviderModel,
  type ProviderWithModels,
} from '~server/providers';
import { ModelSearchInput } from './model-search-input';
import classes from './providers-panel.module.css';

type ToggleChoice = 'catalog' | 'on' | 'off';

type Values = {
  kind: ProviderModel['kind'];
  modelId: string;
  name: string;
  description: string;
  /** Empty follows the catalog. */
  contextWindow: number | '';
  maxTokens: number | '';
  reasoning: ToggleChoice;
  nativeWebSearch: ToggleChoice;
};

const KIND_LABELS: Record<ProviderModel['kind'], PlainTranslationKey> = {
  chat: 'providers.model.kind.chat',
  image: 'providers.model.kind.image',
};

function toggleChoice(value: boolean | null): ToggleChoice {
  return value === null ? 'catalog' : value ? 'on' : 'off';
}

/**
 * Edit one model. Context window, max output and reasoning follow the
 * catalog while left blank (or "Follow catalog"); a value overrides it. The
 * hints always describe the catalog entry chosen in the form, so linking,
 * changing or unlinking it shows what the blank fields will use once saved.
 */
export function ModelFormModal({
  opened,
  onClose,
  provider,
  model,
}: {
  opened: boolean;
  onClose: () => void;
  provider: ProviderWithModels;
  model: ProviderModel;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  // undefined = keep; null = detach; string = use this entry.
  const [catalogRef, setCatalogRef] = useState<string | null | undefined>(
    undefined,
  );
  const [picked, setPicked] = useState<{
    label: string;
    limits: CatalogLimits;
  } | null>(null);
  const [changingRef, setChangingRef] = useState(false);
  const form = useForm<Values>({
    initialValues: {
      kind: model.kind,
      modelId: model.modelId,
      name: model.name,
      description: model.description,
      contextWindow: model.overrides.contextWindow ?? '',
      maxTokens: model.overrides.maxTokens ?? '',
      reasoning: toggleChoice(model.overrides.reasoning),
      nativeWebSearch: toggleChoice(model.overrides.nativeWebSearch),
    },
    validate: {
      modelId: (v) => (v.trim() ? null : t('providers.form.required')),
      description: (v) =>
        Array.from(v.trim()).length > 200
          ? t('providers.model.descriptionTooLong')
          : null,
    },
  });
  const image = form.values.kind === 'image';
  const nativeWebSearchSupported = supportsNativeWebSearch(provider.apiType);
  const ref = catalogRef === undefined ? model.catalogRef : catalogRef;
  const linked = ref !== null && (catalogRef !== undefined || model.inCatalog);
  // The entry the form will save: the stored one until another is chosen.
  const limits: CatalogLimits =
    catalogRef === undefined
      ? (model.chat?.catalogValues ?? {})
      : catalogRef === null
        ? {}
        : (picked?.limits ?? {});
  const typedContextWindow =
    form.values.contextWindow === '' ? null : form.values.contextWindow;
  // What blank fields resolve to with this entry (and the typed context).
  const blank = resolveLimits(
    { reasoning: null, contextWindow: typedContextWindow, maxTokens: null },
    limits,
  );

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      updateModel({
        data: {
          id: model.id,
          kind: values.kind,
          modelId: values.modelId,
          name: values.name,
          description: values.description,
          ...(catalogRef === undefined ? {} : { catalogRef }),
          ...(values.kind === 'chat'
            ? {
                contextWindow:
                  values.contextWindow === '' ? null : values.contextWindow,
                maxTokens: values.maxTokens === '' ? null : values.maxTokens,
                reasoning:
                  values.reasoning === 'catalog'
                    ? null
                    : values.reasoning === 'on',
                ...(nativeWebSearchSupported ||
                values.nativeWebSearch === 'catalog'
                  ? {
                      nativeWebSearch:
                        values.nativeWebSearch === 'catalog'
                          ? null
                          : values.nativeWebSearch === 'on',
                    }
                  : {}),
              }
            : {}),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
        qc.invalidateQueries({
          queryKey: agentModelChoicesQueryOptions.queryKey,
        }),
      ]);
      toast.success(t('providers.toast.modelUpdated'));
      onClose();
    },
  });

  const resetAll = () =>
    form.setValues({
      contextWindow: '',
      maxTokens: '',
      reasoning: 'catalog',
      nativeWebSearch: 'catalog',
    });

  const followLabel =
    limits.reasoning === undefined
      ? t('providers.model.followCatalog')
      : limits.reasoning
        ? t('providers.model.followCatalogOn')
        : t('providers.model.followCatalogOff');
  const number = (value: number) => value.toLocaleString(locale);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('providers.model.edit')}
      centered
    >
      <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
        <Stack gap="sm">
          <Group grow align="flex-start">
            <Select
              label={t('providers.model.category')}
              allowDeselect={false}
              data={[
                { value: 'chat', label: t(KIND_LABELS.chat) },
                {
                  value: 'image',
                  label: t(KIND_LABELS.image),
                  disabled: !provider.canGenerateImages,
                },
              ]}
              {...form.getInputProps('kind')}
            />
            {image ? (
              <Autocomplete
                label={t('providers.model.modelId')}
                data={provider.imageModelSuggestions}
                {...form.getInputProps('modelId')}
              />
            ) : (
              <TextInput
                label={t('providers.model.modelId')}
                {...form.getInputProps('modelId')}
              />
            )}
          </Group>
          <div className={classes.match}>
            <div className={classes.matchText}>
              <Text size="sm" fw={700} truncate>
                {linked && ref
                  ? t('providers.model.catalog', {
                      name:
                        (catalogRef === undefined
                          ? model.catalogLabel
                          : picked?.label) ?? ref,
                    })
                  : t('providers.model.noCatalog')}
              </Text>
              <Text size="xs" c="dimmed">
                {linked
                  ? t('providers.model.followHint')
                  : t('providers.model.noCatalogHint')}
              </Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Anchor
                component="button"
                type="button"
                size="sm"
                fw={700}
                onClick={() => setChangingRef((open) => !open)}
              >
                {linked
                  ? t('providers.model.changeCatalog')
                  : t('providers.model.linkCatalog')}
              </Anchor>
              {linked ? (
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  fw={700}
                  onClick={() => setCatalogRef(null)}
                >
                  {t('providers.model.unlinkCatalog')}
                </Anchor>
              ) : null}
            </Group>
          </div>
          {changingRef ? (
            <ModelSearchInput
              catalogProviderId={null}
              exclude={new Set()}
              focusOnMount
              placeholder={t('providers.search.catalogPlaceholder')}
              onPick={(hit) => {
                if (!hit.catalogRef) return;
                setCatalogRef(hit.catalogRef);
                setPicked({ label: hit.name, limits: hit.limits ?? {} });
                setChangingRef(false);
              }}
            />
          ) : null}
          <TextInput
            label={t('providers.model.displayName')}
            description={t('providers.model.displayNameDescription')}
            placeholder={form.values.modelId.trim()}
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
            />
          ) : (
            <>
              <Group grow align="flex-start">
                <NumberInput
                  label={t('providers.model.contextWindow')}
                  min={1000}
                  step={1000}
                  thousandSeparator=","
                  placeholder={
                    limits.contextWindow
                      ? t('providers.model.followCatalog')
                      : t('providers.model.useDefault')
                  }
                  description={
                    limits.contextWindow
                      ? t('providers.model.catalogValue', {
                          value: number(limits.contextWindow),
                        })
                      : t('providers.model.blankUses', {
                          value: number(FALLBACK_CONTEXT_WINDOW),
                        })
                  }
                  {...form.getInputProps('contextWindow')}
                />
                <NumberInput
                  label={t('providers.model.maxTokens')}
                  min={256}
                  step={256}
                  thousandSeparator=","
                  placeholder={
                    limits.maxTokens
                      ? t('providers.model.followCatalog')
                      : t('providers.model.useDefault')
                  }
                  description={
                    limits.maxTokens
                      ? t('providers.model.catalogValue', {
                          value: number(blank.maxTokens),
                        })
                      : t('providers.model.blankUses', {
                          value: number(blank.maxTokens),
                        })
                  }
                  {...form.getInputProps('maxTokens')}
                />
              </Group>
              <Select
                label={t('providers.model.reasoningField')}
                description={t('providers.model.reasoningFieldDescription')}
                allowDeselect={false}
                data={[
                  { value: 'catalog', label: followLabel },
                  { value: 'on', label: t('providers.model.on') },
                  { value: 'off', label: t('providers.model.off') },
                ]}
                {...form.getInputProps('reasoning')}
              />
              {nativeWebSearchSupported && (
                <Select
                  label={t('providers.model.nativeWebSearch')}
                  description={t(
                    provider.apiType === 'openai-responses'
                      ? 'providers.model.nativeWebSearchOpenAiDescription'
                      : 'providers.model.nativeWebSearchDescription',
                  )}
                  allowDeselect={false}
                  data={[
                    {
                      value: 'catalog',
                      label: resolveNativeWebSearch(
                        null,
                        limits.nativeWebSearch,
                        provider.apiType,
                      )
                        ? t('providers.model.followCatalogOn')
                        : t('providers.model.followCatalogOff'),
                    },
                    { value: 'on', label: t('providers.model.on') },
                    { value: 'off', label: t('providers.model.off') },
                  ]}
                  {...form.getInputProps('nativeWebSearch')}
                />
              )}
            </>
          )}
          <Group justify="space-between" mt="xs">
            {image ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="subtle"
                color="gray"
                onClick={resetAll}
              >
                {t('providers.model.resetAll')}
              </Button>
            )}
            <Group gap="xs">
              <Button type="button" variant="default" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                {t('common.save')}
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
