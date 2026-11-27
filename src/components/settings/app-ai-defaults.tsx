import { Group, Paper, Select, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSparkles } from '@tabler/icons-react';
import { toast } from 'sonner';
import { useI18n } from '~i18n';
import { appAiDefaultsQueryOptions } from '~queries/app-ai';
import {
  setAppAiDefaultsFn,
  type AiDefaultView,
  type AppAiDefaultsView,
} from '~server/app-ai';

type Kind = 'chat' | 'image';

function DefaultSelect({
  kind,
  view,
}: {
  kind: Kind;
  view: AppAiDefaultsView;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const entry: AiDefaultView = view[kind];
  const options = view.models[kind];
  const save = useMutation({
    mutationFn: (model: string | null) =>
      setAppAiDefaultsFn({ data: { [kind]: model } }),
    onSuccess: async (next) => {
      qc.setQueryData(appAiDefaultsQueryOptions.queryKey, next);
      // Every App's unpicked roles follow the new default.
      await qc.invalidateQueries({ queryKey: ['app-ai'] });
      toast.success(t('settings.appAi.saved'));
    },
  });
  const data = options.map((option) => ({
    value: option.id,
    label: `${option.name} · ${option.providerName}`,
  }));
  if (entry.source === 'setting' && entry.unavailable && entry.model)
    data.push({
      value: entry.model.id,
      label: `${entry.model.name} · ${entry.model.providerName}`,
    });
  const first = options[0];
  return (
    <Stack gap={4}>
      <Select
        size="sm"
        label={
          kind === 'chat'
            ? t('settings.appAi.chatLabel')
            : t('settings.appAi.imageLabel')
        }
        data={data}
        value={entry.source === 'setting' ? (entry.model?.id ?? null) : null}
        placeholder={
          first
            ? t('settings.appAi.firstModel', { model: first.name })
            : t('settings.appAi.noModel')
        }
        clearable
        disabled={save.isPending || (!options.length && !entry.model)}
        onChange={(value) => save.mutate(value)}
        comboboxProps={{ withinPortal: true }}
        style={{ flex: 1, minWidth: 220 }}
      />
      {entry.unavailable ? (
        <Text size="xs" c="red">
          {t('settings.appAi.unavailable')}
        </Text>
      ) : null}
    </Stack>
  );
}

/**
 * The default chat and image models for Apps: what every App's AI role uses
 * unless the role has its own pick on the App's page.
 */
export function AppAiDefaults() {
  const { t } = useI18n();
  const { data } = useQuery(appAiDefaultsQueryOptions);
  if (!data) return null;
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Group gap={8} wrap="nowrap">
          <IconSparkles size={16} stroke={1.8} />
          <Text size="sm" fw={700}>
            {t('settings.appAi.title')}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {t('settings.appAi.description')}
        </Text>
        <Group gap="md" align="flex-start" wrap="wrap">
          <DefaultSelect kind="chat" view={data} />
          <DefaultSelect kind="image" view={data} />
        </Group>
      </Stack>
    </Paper>
  );
}
