import { Group, Stack, Switch, Text } from '@mantine/core';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useI18n } from '~i18n';
import { themeQueryOptions } from '~queries/theme';
import { setDockLabelsFn } from '~server/theme';

/** Whether the web dock shows names under its tiles, for everyone. */
export function DockLabelsPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: theme } = useSuspenseQuery(themeQueryOptions);
  const save = useMutation({
    mutationFn: (shown: boolean) => setDockLabelsFn({ data: shown }),
    onSuccess: (saved) =>
      queryClient.setQueryData(themeQueryOptions.queryKey, saved),
  });

  return (
    <Group justify="space-between" gap="md" wrap="nowrap">
      <Stack gap={2}>
        <Text fw={700}>{t('appearance.dockLabels.title')}</Text>
        <Text size="sm" c="dimmed">
          {t('appearance.dockLabels.description')}
        </Text>
      </Stack>
      <Switch
        size="md"
        // While saving, show the requested state; on failure the global
        // mutation toast reports it and the switch returns to the saved value.
        checked={save.isPending ? save.variables : theme.dockLabels}
        disabled={save.isPending}
        onChange={(event) => save.mutate(event.currentTarget.checked)}
        aria-label={t('appearance.dockLabels.title')}
      />
    </Group>
  );
}
