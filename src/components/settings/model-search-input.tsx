import {
  Combobox,
  Group,
  Loader,
  Text,
  TextInput,
  UnstyledButton,
  useCombobox,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useErrorText, useI18n } from '~i18n';
import type { CatalogModel } from '~server/model-catalog/types';
import { fetchProviderModels, searchCatalog } from '~server/providers';
import { formatTokenCount } from './token-count';
import classes from './providers-panel.module.css';

/** What a pick adds: a model id and, when the catalog knows it, its entry. */
export type PickedModel = {
  modelId: string;
  name: string;
  kind: CatalogModel['kind'];
  /** Catalog entry, or null for an id typed by hand or listed by the provider. */
  catalogRef: string | null;
  contextWindow?: number;
};

type Option = PickedModel & { key: string; source: 'catalog' | 'provider' };

const PAGE = 50;

/**
 * Search the catalog (and, once fetched, the provider's own model list) to
 * add models one at a time. Typing an id nothing lists offers it as a custom
 * model. Picked models are shown by the caller, never inside the input.
 */
export function ModelSearchInput({
  catalogProviderId,
  providerId,
  exclude,
  onPick,
  focusOnMount = false,
  placeholder,
}: {
  /** Limit catalog results to this catalog provider; null searches all. */
  catalogProviderId: string | null;
  /** Saved provider whose `/models` list can be fetched. */
  providerId?: string;
  /** Model ids already added; they are left out of the results. */
  exclude: ReadonlySet<string>;
  onPick: (model: PickedModel) => void;
  /** Focus the input when it appears (it was opened on purpose). */
  focusOnMount?: boolean;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const combobox = useCombobox({
    onDropdownClose: () => combobox.resetSelectedOption(),
  });
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);
  const [debounced] = useDebouncedValue(query.trim(), 150);

  const catalog = useQuery({
    queryKey: ['agent', 'catalog', 'search', catalogProviderId, debounced],
    queryFn: () =>
      searchCatalog({
        data: {
          providerId: catalogProviderId ?? undefined,
          query: debounced || undefined,
          limit: PAGE,
        },
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const remote = useMutation({
    mutationFn: () => fetchProviderModels({ data: { id: providerId! } }),
    meta: { errorToast: false },
    onSuccess: (models) =>
      toast.success(t('providers.search.fetched', { count: models.length })),
    onError: (error) =>
      toast.error(errorText(error, 'providers.search.fetchFailed')),
  });

  const options = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const list: Option[] = [];
    for (const hit of catalog.data?.models ?? []) {
      if (exclude.has(hit.model.id) || seen.has(hit.model.id)) continue;
      seen.add(hit.model.id);
      list.push({
        key: `catalog:${hit.providerId}/${hit.model.id}`,
        source: 'catalog',
        modelId: hit.model.id,
        name: hit.model.name,
        kind: hit.model.kind,
        catalogRef: `${hit.providerId}/${hit.model.id}`,
        contextWindow: hit.model.contextWindow,
      });
    }
    for (const model of remote.data ?? []) {
      if (exclude.has(model.modelId) || seen.has(model.modelId)) continue;
      const text = `${model.modelId} ${model.name ?? ''}`.toLowerCase();
      if (!terms.every((term) => text.includes(term))) continue;
      seen.add(model.modelId);
      list.push({
        key: `provider:${model.modelId}`,
        source: 'provider',
        modelId: model.modelId,
        name: model.name ?? model.modelId,
        kind: 'chat',
        catalogRef: null,
      });
    }
    return list;
  }, [catalog.data, exclude, query, remote.data]);

  const typed = query.trim();
  const offerCustom =
    typed.length > 0 &&
    !exclude.has(typed) &&
    !options.some((option) => option.modelId === typed);
  const total = catalog.data?.total ?? 0;

  const pick = (option: PickedModel) => {
    onPick(option);
    setQuery('');
    combobox.resetSelectedOption();
    // Typing again reopens it; an open list would cover what was just added.
    combobox.closeDropdown();
  };

  const submit = (key: string) => {
    if (key === 'custom') {
      pick({ modelId: typed, name: typed, kind: 'chat', catalogRef: null });
      return;
    }
    const option = options.find((item) => item.key === key);
    if (option) pick(option);
  };

  return (
    <Combobox store={combobox} onOptionSubmit={submit} withinPortal={false}>
      <Combobox.Target>
        <TextInput
          ref={inputRef}
          value={query}
          placeholder={placeholder ?? t('providers.search.placeholder')}
          aria-label={t('providers.search.label')}
          leftSection={<IconSearch size={15} stroke={1.7} />}
          rightSection={catalog.isFetching ? <Loader size={14} /> : null}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            combobox.openDropdown();
            combobox.updateSelectedOptionIndex();
          }}
          onFocus={() => combobox.openDropdown()}
          onClick={() => combobox.openDropdown()}
          onBlur={() => combobox.closeDropdown()}
          onKeyDown={(event) => {
            // Enter with nothing highlighted adds the typed id.
            if (
              event.key === 'Enter' &&
              combobox.getSelectedOptionIndex() < 0 &&
              offerCustom
            ) {
              event.preventDefault();
              submit('custom');
            }
          }}
        />
      </Combobox.Target>
      <Combobox.Dropdown>
        {catalogProviderId || providerId ? (
          <Group
            justify="space-between"
            wrap="nowrap"
            className={classes.searchMeta}
          >
            <Text size="xs" c="dimmed">
              {catalog.data
                ? t('providers.search.count', {
                    shown: Math.min(total, PAGE),
                    total,
                  })
                : t('providers.search.searching')}
            </Text>
            {providerId ? (
              <UnstyledButton
                type="button"
                className={classes.searchMetaAction}
                // Keep focus (and the dropdown) in the input.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => remote.mutate()}
                disabled={remote.isPending}
              >
                <Group gap={4} wrap="nowrap">
                  {remote.isPending ? (
                    <Loader size={12} />
                  ) : (
                    <IconRefresh size={13} stroke={1.8} />
                  )}
                  <span>{t('providers.search.fetch')}</span>
                </Group>
              </UnstyledButton>
            ) : null}
          </Group>
        ) : null}
        <Combobox.Options className={classes.searchOptions}>
          {options.map((option) => (
            <Combobox.Option key={option.key} value={option.key}>
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <div className={classes.searchOptionText}>
                  <Text size="sm" truncate>
                    {option.name}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace" truncate>
                    {option.modelId}
                  </Text>
                </div>
                {option.contextWindow ? (
                  <Text size="xs" c="dimmed">
                    {formatTokenCount(option.contextWindow)}
                  </Text>
                ) : null}
              </Group>
            </Combobox.Option>
          ))}
          {offerCustom ? (
            <Combobox.Option value="custom">
              <Group gap={6} wrap="nowrap">
                <IconPlus size={14} stroke={2} />
                <Text size="sm" fw={600} c="primary" truncate>
                  {t('providers.search.addCustom', { id: typed })}
                </Text>
              </Group>
            </Combobox.Option>
          ) : null}
          {!options.length && !offerCustom ? (
            <Combobox.Empty>
              {catalog.isFetching
                ? t('providers.search.searching')
                : t('providers.search.empty')}
            </Combobox.Empty>
          ) : null}
        </Combobox.Options>
      </Combobox.Dropdown>
    </Combobox>
  );
}
