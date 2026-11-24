import { ActionIcon, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconTable, IconTrash } from '@tabler/icons-react';
import { Trans } from 'react-i18next';
import { useI18n } from '~i18n';
import { DeleteDatabaseForm } from './delete-database-form';
import { SectionHeader, StatusDot } from './section-header';

export function RetainedDataTableSection({
  appId,
  appName,
  dbName,
  schemaHash,
  onDelete,
}: {
  appId: string;
  appName: string;
  dbName: string;
  schemaHash: string | null;
  onDelete: (dbName: string, appName: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const confirmDelete = () => {
    const modalId = `delete-app-data-database-${appId}`;
    modals.open({
      modalId,
      title: t('ops.retained.deleteTitle'),
      centered: true,
      children: (
        <DeleteDatabaseForm
          appName={appName}
          managed
          modalId={modalId}
          onDelete={(confirmation) => onDelete(dbName, confirmation)}
        />
      ),
    });
  };

  return (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" align="center">
        <Box style={{ minWidth: 0 }}>
          <SectionHeader
            icon={<IconTable size={16} stroke={1.8} />}
            title={t('ops.dataTable.title')}
            meta={
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <StatusDot active={false} />
                <Text size="xs" c="dimmed">
                  {t('common.disabled')}
                </Text>
                <Text size="xs" c="dimmed">
                  ·
                </Text>
                <Text size="xs" c="dimmed" ff="monospace" truncate>
                  {dbName}
                </Text>
              </Group>
            }
          />
        </Box>
        <Tooltip
          label={t('ops.retained.deleteTooltip')}
          withArrow
          position="top"
        >
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label={t('ops.retained.deleteLabel', { name: dbName })}
            onClick={confirmDelete}
          >
            <IconTrash size={15} stroke={1.8} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed">
        {t('ops.retained.body')}
      </Text>
      {schemaHash ? (
        <Text size="xs" c="dimmed">
          <Trans
            t={t}
            i18nKey="ops.retained.latestSchema"
            values={{ hash: schemaHash.slice(0, 10) }}
            components={{
              hash: <Text span ff="monospace" title={schemaHash} />,
            }}
          />
        </Text>
      ) : null}
    </Stack>
  );
}
