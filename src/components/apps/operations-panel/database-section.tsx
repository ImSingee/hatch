import { ActionIcon, Box, Group, Stack, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { IconDatabase, IconTrash } from '@tabler/icons-react';
import { useI18n } from '~i18n';
import { DeleteDatabaseForm } from './delete-database-form';
import { SectionHeader, StatusDot } from './section-header';

export type DatabaseOperationState = {
  enabled: boolean;
  dbName: string | null;
};

export function DatabaseSection({
  appId,
  appName,
  database,
  onDelete,
}: {
  appId: string;
  appName: string;
  database: DatabaseOperationState;
  onDelete: (dbName: string, appName: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const { enabled, dbName } = database;
  if (!enabled && !dbName) return null;

  const confirmDelete = () => {
    if (enabled || !dbName) return;
    const modalId = `delete-app-database-${appId}`;
    modals.open({
      modalId,
      title: t('ops.database.deleteTitle'),
      centered: true,
      children: (
        <DeleteDatabaseForm
          appName={appName}
          managed={false}
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
            icon={<IconDatabase size={16} stroke={1.8} />}
            title={t('ops.database.title')}
            meta={
              <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                <StatusDot active={enabled} />
                <Text size="xs" c="dimmed">
                  {enabled ? t('common.enabled') : t('common.disabled')}
                </Text>
                <Text size="xs" c="dimmed">
                  ·
                </Text>
                {dbName ? (
                  <Text size="xs" c="dimmed" ff="monospace" truncate>
                    {dbName}
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed">
                    {t('ops.database.notProvisionedStatus')}
                  </Text>
                )}
              </Group>
            }
          />
        </Box>
        {!enabled && dbName ? (
          <Tooltip label={t('ops.database.delete')} withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="red"
              size="sm"
              aria-label={t('ops.database.deleteLabel', { name: dbName })}
              onClick={confirmDelete}
            >
              <IconTrash size={15} stroke={1.8} />
            </ActionIcon>
          </Tooltip>
        ) : null}
      </Group>
      <Text size="xs" c="dimmed">
        {enabled
          ? dbName
            ? t('ops.database.dedicated')
            : t('ops.database.provisionedOnDeploy')
          : t('ops.database.disabledNote')}
      </Text>
    </Stack>
  );
}
