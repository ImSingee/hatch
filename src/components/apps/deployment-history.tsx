import {
  Badge,
  Box,
  Button,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { IconDownload, IconFileZip, IconRobot } from '@tabler/icons-react';
import { toast } from 'sonner';
import { useI18n } from '~i18n';
import {
  BuildLogContent,
  DeploymentHistoryView,
  metaItemClass,
} from '~components/deployments/deployment-history';
import { requiresAgentRollback } from '~components/deployments/deployment-history-policy';
import {
  appOpsQueryOptions,
  deploymentBuildLogQueryOptions,
  deploymentsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { rollbackAppFn } from '~server/apps';
import {
  requiresDataSchemaConfirmation,
  rollbackNotification,
} from './deployment-history-policy';

// Fetch the (potentially large) build log only once the row is expanded.
function AppBuildLog({
  appId,
  deploymentId,
  enabled,
}: {
  appId: string;
  deploymentId: string;
  enabled: boolean;
}) {
  const query = useQuery({
    ...deploymentBuildLogQueryOptions(appId, deploymentId),
    enabled,
  });
  return <BuildLogContent query={query} />;
}

export function DeploymentHistory({ appId }: { appId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const qc = useQueryClient();
  const query = useQuery(deploymentsQueryOptions(appId));

  const rollback = useMutation({
    mutationFn: (deploymentId: string) =>
      rollbackAppFn({ data: { id: appId, deploymentId } }),
    onSuccess: (result) => {
      const notification = rollbackNotification(result);
      toast[notification.tone](
        t(notification.key, { version: result.version }),
      );
      void qc.invalidateQueries(deploymentsQueryOptions(appId));
      // Rolling back can change backend/cron/webhook capabilities, so
      // refresh the Operations panel on this page too; the deployments + loader
      // invalidation alone leaves its cached ops data stale.
      void qc.invalidateQueries(appOpsQueryOptions(appId));
      // The restored deployment may declare a different RPC API (proto), so
      // refresh the API panel's manifest cache as well — otherwise it keeps
      // showing the previous deployment's services/proto until a focus refetch.
      void qc.invalidateQueries(normalizedManifestQueryOptions(appId));
      void router.invalidate();
    },
  });

  const requestRollback = (deploymentId: string) => {
    const deployment = query.data?.find((item) => item.id === deploymentId);
    if (!requiresDataSchemaConfirmation(deployment)) {
      rollback.mutate(deploymentId);
      return;
    }
    modals.openConfirmModal({
      title: t('deployments.schemaConfirm.title'),
      children: <Text size="sm">{t('deployments.schemaConfirm.body')}</Text>,
      labels: {
        confirm: t('deployments.schemaConfirm.confirm'),
        cancel: t('common.cancel'),
      },
      confirmProps: { color: 'orange' },
      onConfirm: () => rollback.mutate(deploymentId),
    });
  };

  return (
    <DeploymentHistoryView
      deployments={query.data ?? []}
      isLoading={query.isLoading}
      onRollback={requestRollback}
      rollingId={rollback.isPending ? (rollback.variables ?? null) : null}
      renderVersionMeta={(deployment) =>
        deployment.compatibility.isLatest ? null : (
          <Badge size="xs" variant="light" color="orange">
            {t('deployments.compatibilityBadge', {
              version: deployment.compatibility.version,
            })}
          </Badge>
        )
      }
      renderRollbackAction={(deployment, defaultAction) => {
        if (!requiresAgentRollback(deployment)) return defaultAction;
        const requiresNewerPlatform =
          deployment.compatibility.version >
          deployment.compatibility.latestVersion;
        return (
          <Tooltip
            label={
              requiresNewerPlatform
                ? t('deployments.agentRestore.newerPlatform')
                : t('deployments.agentRestore.belowMinimum')
            }
            withArrow
          >
            <Button
              size="compact-sm"
              variant="light"
              color="orange"
              leftSection={<IconRobot size={14} />}
              renderRoot={(props) => (
                <Link
                  to="/agent"
                  search={{
                    prompt: requiresNewerPlatform
                      ? `Restore App ${appId} to v${deployment.version}. Its compatibility is newer than this platform, so keep its runtime disabled until the platform is updated.`
                      : `Restore App ${appId} to v${deployment.version}, then update and redeploy it for the latest platform compatibility.`,
                  }}
                  {...props}
                />
              )}
            >
              {t('deployments.useAgent')}
            </Button>
          </Tooltip>
        );
      }}
      renderArtifact={(deployment) =>
        deployment.hasArtifact ? (
          <Tooltip
            label={t('deployments.downloadArtifact')}
            withArrow
            position="top"
          >
            <UnstyledButton
              component="a"
              href={`/api/app/${appId}/download?mode=artifact&deployment=${deployment.id}`}
              download
              className={metaItemClass}
            >
              <IconFileZip size={13} stroke={1.6} />
              <Text size="xs">{t('deployments.artifact')}</Text>
              <IconDownload size={12} stroke={1.6} />
            </UnstyledButton>
          </Tooltip>
        ) : (
          <Box component="span" className={metaItemClass}>
            <IconFileZip size={13} stroke={1.6} />
            <Text size="xs">{t('deployments.artifactPruned')}</Text>
          </Box>
        )
      }
      renderBuildLog={(deploymentId, open) => (
        <AppBuildLog appId={appId} deploymentId={deploymentId} enabled={open} />
      )}
    />
  );
}
