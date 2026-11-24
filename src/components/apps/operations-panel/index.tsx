import { Center, Group, Loader, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFolder, IconServerBolt } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  BackendControls,
  BackendStatus,
  BackendTime,
  backendLastExitLabel,
} from '~components/apps/backend-controls';
import { GroupCard, Section } from '~components/page/page';
import { ExtraPermissionsDetails } from '~components/system/extra-permissions';
import { NetworkAccessDetails } from '~components/system/network-access';
import {
  appBackendsQueryOptions,
  appOpsQueryOptions,
  deploymentsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import {
  deleteAppDataDatabaseFn,
  deleteAppDatabaseFn,
  type AppOps,
} from '~server/apps';
import { CronSection } from './cron-section';
import { DataTableSection } from './data-table-section';
import { DatabaseSection } from './database-section';
import { KvSection } from './kv-section';
import { NotificationsSection } from './notifications-section';
import { RetainedDataTableSection } from './retained-data-table-section';
import { SectionHeader } from './section-header';
import { TasksSection } from './tasks-section';
import { WebhookSection } from './webhook-section';
import { appTasksQueryOptions } from '~queries/app-tasks';

/** One runtime metadata row, matching the Overview `Field` layout. */
function RuntimeFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Group gap="md" wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
        {label}
      </Text>
      {children}
    </Group>
  );
}

function BackendSection({
  appId,
  backend,
  runtimeSupported,
}: {
  appId: string;
  backend: AppOps['backend'];
  runtimeSupported: boolean;
}) {
  // The runtime state lives in the polled Backends list (the same query the
  // Backends page uses), so this section stays live and shares its cache.
  const { data: backends } = useQuery(appBackendsQueryOptions);
  const entry = backends?.find((b) => b.id === appId);
  const runtime = entry?.runtime ?? null;
  const mode = entry?.mode ?? backend.mode ?? 'serverless';

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconServerBolt size={16} stroke={1.8} />}
        title="Backend"
        meta={
          runtime ? (
            <Group gap={10} wrap="nowrap">
              <Group gap={6} wrap="nowrap">
                <BackendStatus runtime={runtime} size="xs" dimmed />
                <Text size="xs" c="dimmed">
                  · {mode}
                </Text>
              </Group>
              <BackendControls
                appId={appId}
                runtime={runtime}
                size="sm"
                runtimeSupported={runtimeSupported}
              />
            </Group>
          ) : backends ? (
            <Text size="xs" c="dimmed">
              not deployed · {mode}
            </Text>
          ) : null
        }
      />
      <Text size="xs" c="dimmed">
        {mode === 'long-running'
          ? 'Kept warm by the platform and restarted automatically if it exits.'
          : 'Started on demand and stopped once it has been idle for a while; the next request starts a fresh instance.'}
      </Text>
      <RuntimeFact label="Network">
        <NetworkAccessDetails access={backend.network} appPlatformChannels />
      </RuntimeFact>
      <RuntimeFact label="Extra permissions">
        <ExtraPermissionsDetails access={backend.extraPermissions} />
      </RuntimeFact>
      {runtime ? (
        <Stack gap={6} mt={4}>
          <RuntimeFact label="PID / Port">
            {runtime.state === 'running' && runtime.pid != null ? (
              <Text size="sm" ff="monospace">
                {runtime.pid} · :{runtime.port}
              </Text>
            ) : (
              <Text size="sm" c="dimmed">
                —
              </Text>
            )}
          </RuntimeFact>
          <RuntimeFact label="Started">
            <BackendTime value={runtime.startedAt} />
          </RuntimeFact>
          <RuntimeFact label="Last stopped">
            <BackendTime value={runtime.stoppedAt} />
          </RuntimeFact>
          <RuntimeFact label="Last exit">
            <Text size="sm" c="dimmed" ff="monospace">
              {backendLastExitLabel(runtime)}
            </Text>
          </RuntimeFact>
        </Stack>
      ) : null}
    </Stack>
  );
}

function PersistentStorageSection() {
  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconFolder size={16} stroke={1.8} />}
        title="Persistent storage"
        meta={
          <Text size="xs" c="dimmed">
            enabled
          </Text>
        }
      />
      <Text size="xs" c="dimmed">
        A private backend directory available through STORAGE_DIR. Files survive
        restarts, deployments, and rollbacks, and are deleted with the app.
        Disabling storage keeps the files but revokes access.
      </Text>
    </Stack>
  );
}

export function OperationsPanel({
  appId,
  appName,
  appSlug,
  runtimeSupported = true,
}: {
  appId: string;
  appName: string;
  /** Links into the App's Tasks pages; without it the section is hidden. */
  appSlug?: string;
  /** Whether controls that invoke App code may run. */
  runtimeSupported?: boolean;
}) {
  const query = useQuery(appOpsQueryOptions(appId));
  const manifestQuery = useQuery(normalizedManifestQueryOptions(appId));
  const notifications = manifestQuery.data?.notifications;
  const { data: tasks } = useQuery({
    ...appTasksQueryOptions(appId),
    enabled: Boolean(manifestQuery.data?.tasks),
  });
  const queryClient = useQueryClient();

  const deleteDatabase = async (dbName: string, confirmation: string) => {
    await deleteAppDatabaseFn({
      data: { id: appId, dbName, appName: confirmation },
    });
    toast.success('Database deleted');
    await Promise.allSettled([
      queryClient.invalidateQueries(appOpsQueryOptions(appId)),
      queryClient.invalidateQueries(deploymentsQueryOptions(appId)),
    ]);
  };

  const deleteDataDatabase = async (dbName: string, confirmation: string) => {
    await deleteAppDataDatabaseFn({
      data: { id: appId, dbName, appName: confirmation },
    });
    toast.success('Data Table data deleted');
    await Promise.allSettled([
      queryClient.invalidateQueries(appOpsQueryOptions(appId)),
      queryClient.invalidateQueries(deploymentsQueryOptions(appId)),
    ]);
  };

  if (query.isLoading) {
    return (
      <Section id="operations" title="Operations">
        <GroupCard padded>
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        </GroupCard>
      </Section>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  const databaseVisible = ops.database.enabled || Boolean(ops.database.dbName);
  const dataTableVisible =
    ops.dataTable.enabled || Boolean(ops.dataTable.dbName);
  const hasOperations =
    ops.backend.capable ||
    databaseVisible ||
    ops.storage.enabled ||
    ops.cron.enabled ||
    ops.webhook.enabled ||
    ops.kv.enabled ||
    dataTableVisible ||
    Boolean(notifications) ||
    Boolean(tasks);

  return (
    <Section id="operations" title="Operations">
      {!hasOperations ? (
        <GroupCard padded>
          <Text size="sm" c="dimmed">
            No database, Data Tables, persistent storage, backend, scheduled
            jobs, webhook, KV, or notifications to manage for this app.
          </Text>
        </GroupCard>
      ) : (
        <Stack gap="sm">
          {ops.backend.capable ? (
            <GroupCard padded id="backend">
              <BackendSection
                appId={appId}
                backend={ops.backend}
                runtimeSupported={runtimeSupported}
              />
            </GroupCard>
          ) : null}
          {databaseVisible ? (
            <GroupCard padded id="database">
              <DatabaseSection
                appId={appId}
                appName={appName}
                database={ops.database}
                onDelete={deleteDatabase}
              />
            </GroupCard>
          ) : null}
          {ops.storage.enabled ? (
            <GroupCard padded id="storage">
              <PersistentStorageSection />
            </GroupCard>
          ) : null}
          {ops.dataTable.enabled ? (
            <GroupCard padded id="data-tables">
              <DataTableSection appId={appId} />
            </GroupCard>
          ) : ops.dataTable.dbName ? (
            <GroupCard padded id="data-tables">
              <RetainedDataTableSection
                appId={appId}
                appName={appName}
                dbName={ops.dataTable.dbName}
                schemaHash={ops.dataTable.schemaHash}
                onDelete={deleteDataDatabase}
              />
            </GroupCard>
          ) : null}
          {ops.cron.enabled ? (
            <GroupCard padded id="schedules">
              <CronSection
                appId={appId}
                cron={ops.cron}
                runtimeSupported={runtimeSupported}
              />
            </GroupCard>
          ) : null}
          {tasks && appSlug ? (
            <GroupCard padded id="tasks">
              <TasksSection appSlug={appSlug} tasks={tasks} />
            </GroupCard>
          ) : null}
          {ops.webhook.enabled ? (
            <GroupCard padded id="webhook">
              <WebhookSection webhook={ops.webhook} />
            </GroupCard>
          ) : null}
          {ops.kv.enabled ? (
            <GroupCard padded id="kv">
              <KvSection appId={appId} />
            </GroupCard>
          ) : null}
          {notifications ? (
            <GroupCard padded id="notifications">
              <NotificationsSection notifications={notifications} />
            </GroupCard>
          ) : null}
        </Stack>
      )}
    </Section>
  );
}
