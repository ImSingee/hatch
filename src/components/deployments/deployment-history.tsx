import {
  Badge,
  Box,
  Button,
  Center,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  IconCheck,
  IconChevronRight,
  IconGitCommit,
  IconLoader,
  IconRestore,
  IconTag,
  IconX,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import { GroupCard, Section } from '~components/page/page';
import type { RollbackBlockedCode } from '~server/apps/rollback-policy';
import classes from './deployment-history.module.css';

/** Structural shape of an App `DeploymentSummary` the timeline renders. */
export type DeploymentLike = {
  id: string;
  version: number;
  status: 'building' | 'deployed' | 'failed';
  message: string | null;
  error: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
  /** Why a deployed version cannot be restored, if a resource is gone. */
  rollbackBlockedCode?: RollbackBlockedCode | null;
  sourceCommit: string | null;
  sourceTag: string | null;
  hasArtifact: boolean;
  hasBuildLog: boolean;
};

const STATUS_META: Record<
  DeploymentLike['status'],
  { color: string; label: PlainTranslationKey; icon: ReactNode }
> = {
  building: {
    color: 'primary',
    label: 'deployments.status.building',
    icon: <IconLoader size={11} stroke={2.5} />,
  },
  deployed: {
    color: 'primary',
    label: 'deployments.status.deployed',
    icon: <IconCheck size={11} stroke={2.5} />,
  },
  failed: {
    color: 'red',
    label: 'deployments.status.failed',
    icon: <IconX size={11} stroke={2.5} />,
  },
};

const ROLLBACK_BLOCKED: Record<RollbackBlockedCode, PlainTranslationKey> = {
  database: 'deployments.rollbackBlocked.database',
  dataTable: 'deployments.rollbackBlocked.dataTable',
  databases: 'deployments.rollbackBlocked.databases',
};

const shortSha = (sha: string) => sha.slice(0, 7);

/** Inline meta-row chip style for wrapper-provided artifact links. */
export const metaItemClass = classes.metaItem;

export function MetaDot() {
  return (
    <Text span size="xs" className={classes.metaDot}>
      ·
    </Text>
  );
}

/**
 * Loading / error / content states for a lazily-fetched build log. Wrappers own
 * the query (each side has its own query options); this renders the result.
 */
export function BuildLogContent({
  query,
}: {
  query: UseQueryResult<string | null>;
}) {
  const { t } = useI18n();
  if (query.isLoading) {
    return (
      <Group gap={6} className={classes.metaItem}>
        <Loader size="xs" />
        <Text size="xs">{t('deployments.buildLog.loading')}</Text>
      </Group>
    );
  }
  if (query.isError) {
    return (
      <Text size="xs" c="red">
        {t('deployments.buildLog.loadFailed')}
      </Text>
    );
  }
  if (query.data) {
    return (
      <Code block className={classes.logCode}>
        {query.data}
      </Code>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      {t('deployments.buildLog.empty')}
    </Text>
  );
}

function DeploymentItem<TDeployment extends DeploymentLike>({
  deployment,
  onRollback,
  rolling,
  renderArtifact,
  renderBuildLog,
  renderVersionMeta,
  renderRollbackAction,
}: {
  deployment: TDeployment;
  onRollback: (deploymentId: string) => void;
  rolling: boolean;
  /** Download link(s) shown for a deployed version, or null to omit. */
  renderArtifact: (deployment: TDeployment) => ReactNode;
  /** Lazily-fetched build log body (mounted only when `hasBuildLog`). */
  renderBuildLog: (deploymentId: string, open: boolean) => ReactNode;
  renderVersionMeta?: (deployment: TDeployment) => ReactNode;
  renderRollbackAction?: (
    deployment: TDeployment,
    defaultAction: ReactNode,
  ) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const [open, handlers] = useDisclosure(false);
  const blockedReason = deployment.rollbackBlockedCode
    ? t(ROLLBACK_BLOCKED[deployment.rollbackBlockedCode])
    : null;
  const hasLog = Boolean(deployment.error) || deployment.hasBuildLog;
  const rollbackReasonId = `rollback-reason-${deployment.id}`;
  const artifactNode =
    deployment.status === 'deployed' ? renderArtifact(deployment) : null;
  const defaultRollbackAction =
    deployment.canRollback || blockedReason ? (
      <Button
        size="compact-sm"
        variant="default"
        leftSection={<IconRestore size={14} />}
        loading={deployment.canRollback && rolling}
        disabled={!deployment.canRollback}
        aria-describedby={blockedReason ? rollbackReasonId : undefined}
        onClick={() => {
          if (deployment.canRollback) onRollback(deployment.id);
        }}
      >
        {t('deployments.restore')}
      </Button>
    ) : null;

  const body = (
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fw={700} size="sm" className={classes.version}>
            v{deployment.version}
          </Text>
          {deployment.isCurrent ? (
            <Badge size="xs" variant="filled" radius="sm" color="primary">
              {t('deployments.live')}
            </Badge>
          ) : null}
          {renderVersionMeta?.(deployment)}
          {/* "Deployed" is the expected default; only surface the label for the
              states that actually need calling out (building / failed). */}
          {deployment.status !== 'deployed' ? (
            <Text size="xs" c="dimmed">
              {t(STATUS_META[deployment.status].label)}
            </Text>
          ) : null}
          <MetaDot />
          <Text size="xs" c="dimmed" truncate>
            {formatRelativeTime(deployment.createdAt, locale)}
          </Text>
        </Group>
        {renderRollbackAction
          ? renderRollbackAction(deployment, defaultRollbackAction)
          : defaultRollbackAction}
      </Group>

      {blockedReason ? (
        <Text
          id={rollbackReasonId}
          size="xs"
          c="dimmed"
          style={{ maxWidth: '70ch' }}
        >
          {blockedReason}
        </Text>
      ) : null}

      {deployment.sourceCommit ||
      deployment.sourceTag ||
      artifactNode != null ? (
        <Group gap="sm" wrap="wrap">
          {deployment.sourceTag ? (
            <Box component="span" className={classes.metaItem}>
              <IconTag size={13} stroke={1.6} />
              <Text size="xs" ff="monospace">
                {deployment.sourceTag}
              </Text>
            </Box>
          ) : null}
          {deployment.sourceCommit ? (
            <>
              {deployment.sourceTag ? <MetaDot /> : null}
              <Tooltip
                label={t('deployments.copyCommit')}
                withArrow
                position="top"
              >
                <UnstyledButton
                  type="button"
                  className={classes.metaItem}
                  onClick={() => {
                    if (!deployment.sourceCommit) return;
                    copy(deployment.sourceCommit);
                    toast.success(t('deployments.commitCopied'));
                  }}
                >
                  <IconGitCommit size={13} stroke={1.6} />
                  <Text size="xs" ff="monospace">
                    {shortSha(deployment.sourceCommit)}
                  </Text>
                </UnstyledButton>
              </Tooltip>
            </>
          ) : null}
          {artifactNode != null ? (
            <>
              {deployment.sourceCommit || deployment.sourceTag ? (
                <MetaDot />
              ) : null}
              {artifactNode}
            </>
          ) : null}
        </Group>
      ) : null}

      {deployment.message ? (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {deployment.message}
        </Text>
      ) : null}

      {hasLog ? (
        <Box>
          <UnstyledButton
            type="button"
            onClick={handlers.toggle}
            className={classes.logToggle}
          >
            <IconChevronRight
              size={14}
              className={`${classes.chevron} ${open ? classes.chevronOpen : ''}`}
            />
            <Text size="xs" c="dimmed" fw={600}>
              {deployment.status === 'failed'
                ? t('deployments.errorLog')
                : t('deployments.buildLog.title')}
            </Text>
          </UnstyledButton>
          <Collapse expanded={open}>
            <Stack gap={6} mt={6}>
              {deployment.error ? (
                <Code
                  block
                  className={`${classes.logCode} ${classes.logError}`}
                >
                  {deployment.error}
                </Code>
              ) : null}
              {deployment.hasBuildLog
                ? renderBuildLog(deployment.id, open)
                : null}
            </Stack>
          </Collapse>
        </Box>
      ) : null}
    </Stack>
  );

  const meta = STATUS_META[deployment.status];

  return (
    <Timeline.Item
      lineVariant={deployment.status === 'failed' ? 'dashed' : 'solid'}
      bullet={
        <ThemeIcon
          size={20}
          radius="xl"
          color={meta.color}
          variant={deployment.isCurrent ? 'filled' : 'light'}
        >
          {meta.icon}
        </ThemeIcon>
      }
    >
      {deployment.isCurrent ? (
        <Box className={classes.currentItem}>{body}</Box>
      ) : (
        body
      )}
    </Timeline.Item>
  );
}

/**
 * Deployment-history timeline for apps. Wrappers own the
 * data fetching and rollback mutation (query keys and invalidations differ);
 * this owns all presentation.
 */
export function DeploymentHistoryView<TDeployment extends DeploymentLike>({
  deployments,
  isLoading,
  onRollback,
  rollingId,
  renderArtifact,
  renderBuildLog,
  renderVersionMeta,
  renderRollbackAction,
}: {
  deployments: TDeployment[];
  isLoading: boolean;
  onRollback: (deploymentId: string) => void;
  /** Deployment id currently being restored, if any. */
  rollingId: string | null;
  renderArtifact: (deployment: TDeployment) => ReactNode;
  renderBuildLog: (deploymentId: string, open: boolean) => ReactNode;
  /** Optional metadata shown beside the version and Live badge. */
  renderVersionMeta?: (deployment: TDeployment) => ReactNode;
  /** Optional action override; receives the standard Restore button. */
  renderRollbackAction?: (
    deployment: TDeployment,
    defaultAction: ReactNode,
  ) => ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Section
      id="deployments"
      title={t('deployments.title')}
      meta={
        deployments.length > 0
          ? t('deployments.versions', { count: deployments.length })
          : undefined
      }
    >
      <GroupCard padded>
        {isLoading ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : deployments.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('deployments.empty')}
          </Text>
        ) : (
          <Timeline
            bulletSize={20}
            lineWidth={2}
            active={-1}
            color="gray"
            styles={{
              itemBody: { paddingBottom: 'var(--mantine-spacing-md)' },
            }}
          >
            {deployments.map((deployment) => (
              <DeploymentItem
                key={deployment.id}
                deployment={deployment}
                onRollback={onRollback}
                rolling={rollingId === deployment.id}
                renderArtifact={renderArtifact}
                renderBuildLog={renderBuildLog}
                renderVersionMeta={renderVersionMeta}
                renderRollbackAction={renderRollbackAction}
              />
            ))}
          </Timeline>
        )}
      </GroupCard>
    </Section>
  );
}
