import {
  Badge,
  Button,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { IconChevronRight, IconGitCommit } from '@tabler/icons-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { type PlainTranslationKey, useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import { GroupCard, Section } from '~components/page/page';
import {
  appOpsQueryOptions,
  deploymentRequestLogQueryOptions,
  deploymentRequestsQueryOptions,
  deploymentsQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import {
  type AppDeploymentRequestView,
  cancelAppDeploymentFn,
} from '~server/apps';
import classes from './deployment-activity.module.css';

const STATUS: Record<
  string,
  { label: PlainTranslationKey; color: string; active: boolean }
> = {
  queued: {
    label: 'deployments.request.status.queued',
    color: 'gray',
    active: true,
  },
  awaiting_artifact: {
    label: 'deployments.request.status.awaitingArtifact',
    color: 'gray',
    active: true,
  },
  building: {
    label: 'deployments.request.status.building',
    color: 'blue',
    active: true,
  },
  verifying: {
    label: 'deployments.request.status.verifying',
    color: 'blue',
    active: true,
  },
  releasing: {
    label: 'deployments.request.status.releasing',
    color: 'blue',
    active: true,
  },
  ready: {
    label: 'deployments.request.status.ready',
    color: 'primary',
    active: false,
  },
  failed: {
    label: 'deployments.request.status.failed',
    color: 'red',
    active: false,
  },
  canceled: {
    label: 'deployments.request.status.canceled',
    color: 'gray',
    active: false,
  },
  superseded: {
    label: 'deployments.request.status.superseded',
    color: 'gray',
    active: false,
  },
};

const CANCELABLE = new Set(['queued', 'awaiting_artifact', 'building']);

function DeploymentLog({
  appId,
  deploymentId,
}: {
  appId: string;
  deploymentId: string;
}) {
  const { t } = useI18n();
  const query = useQuery(deploymentRequestLogQueryOptions(appId, deploymentId));
  if (query.isLoading) return <Loader size="xs" />;
  if (query.isError) {
    return (
      <Text size="xs" c="red">
        {t('deployments.buildLog.loadFailed')}
      </Text>
    );
  }
  const lines = query.data?.lines ?? [];
  if (lines.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {t('deployments.request.logEmpty')}
      </Text>
    );
  }
  return (
    <Code block className={classes.log} aria-live="polite">
      {lines.map((line) => line.text).join('\n')}
    </Code>
  );
}

function DeploymentRequest({
  appId,
  deployment,
}: {
  appId: string;
  deployment: AppDeploymentRequestView;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [open, { toggle }] = useDisclosure(!deployment.finished);
  const status = STATUS[deployment.status] ?? STATUS.failed;
  const cancel = useMutation({
    mutationFn: () =>
      cancelAppDeploymentFn({
        data: { id: appId, deploymentId: deployment.id },
      }),
    onSuccess: () => {
      toast.success(t('deployments.request.canceled'));
      void qc.invalidateQueries(deploymentRequestsQueryOptions(appId));
    },
    onError: () => {
      toast.error(t('deployments.request.cancelFailed'));
      void qc.invalidateQueries(deploymentRequestsQueryOptions(appId));
    },
  });
  return (
    <Stack gap={6} className={classes.item}>
      <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap={8} wrap="nowrap">
            {/* <output> is a status live region: changes are announced. */}
            <Badge
              component="output"
              aria-live="polite"
              aria-atomic
              size="sm"
              variant="light"
              color={status.color}
              leftSection={status.active ? <Loader size={10} /> : undefined}
            >
              {t(status.label)}
            </Badge>
            <Text size="xs" c="dimmed">
              {t(
                deployment.build === 'builder'
                  ? 'deployments.request.build.builder'
                  : 'deployments.request.build.local',
              )}
            </Text>
          </Group>
          <Text size="sm" lineClamp={2}>
            {deployment.message}
          </Text>
          <Group gap={6} className={classes.meta}>
            <IconGitCommit size={13} stroke={1.6} />
            <Text size="xs" ff="monospace">
              {deployment.commit.slice(0, 7)}
            </Text>
            <Text size="xs">·</Text>
            <Text size="xs">
              {formatRelativeTime(deployment.createdAt, locale)}
            </Text>
          </Group>
        </Stack>
        {CANCELABLE.has(deployment.status) ? (
          <Button
            size="compact-sm"
            variant="default"
            loading={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {t('deployments.request.cancel')}
          </Button>
        ) : null}
      </Group>
      {deployment.status === 'failed' && deployment.errorMessage ? (
        <Text size="xs" c="red" className={classes.error}>
          {deployment.errorMessage}
        </Text>
      ) : null}
      <UnstyledButton
        onClick={toggle}
        className={classes.toggle}
        aria-expanded={open}
      >
        <IconChevronRight
          size={12}
          className={open ? classes.chevronOpen : classes.chevron}
        />
        <Text size="xs">{t('deployments.request.log')}</Text>
      </UnstyledButton>
      <Collapse expanded={open}>
        {open ? (
          <DeploymentLog appId={appId} deploymentId={deployment.id} />
        ) : null}
      </Collapse>
    </Stack>
  );
}

/**
 * Deployments that are under way or did not become a version: queued,
 * building, releasing, failed, canceled or superseded. Released ones appear
 * in the version history below.
 */
export function DeploymentActivity({ appId }: { appId: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const router = useRouter();
  const query = useQuery(deploymentRequestsQueryOptions(appId));
  const data = query.data;

  // A deployment released while the page is open changes the version
  // history, the operations panel and the API panel. It may start and finish
  // between two polls, so any release that was not ready in the previous
  // snapshot counts, including one this page never saw building. The first
  // snapshot fetched for this App is the baseline: it raises no toasts, but
  // the rest of the page may have loaded before a release in it finished, so
  // it still refreshes what depends on releases.
  const seen = useRef<{ appId: string; statuses: Map<string, string> | null }>({
    appId,
    statuses: null,
  });
  const fetched = query.isFetchedAfterMount;
  useEffect(() => {
    if (seen.current.appId !== appId) {
      seen.current = { appId, statuses: null };
    }
    // Cached data from an earlier visit is not a baseline: the release
    // history may have moved on since.
    if (!data || !fetched) return;
    const previous = seen.current.statuses;
    const released: AppDeploymentRequestView[] = [];
    const statuses = new Map<string, string>();
    for (const deployment of data.deployments) {
      statuses.set(deployment.id, deployment.status);
      if (
        previous &&
        deployment.status === 'ready' &&
        previous.get(deployment.id) !== 'ready'
      ) {
        released.push(deployment);
      }
    }
    seen.current.statuses = statuses;
    const baselineHasRelease =
      previous === null &&
      data.deployments.some((deployment) => deployment.status === 'ready');
    if (released.length === 0 && !baselineHasRelease) return;
    for (const deployment of released) {
      toast.success(
        t('deployments.request.released', {
          version: deployment.version ?? 0,
        }),
      );
    }
    void qc.invalidateQueries(deploymentsQueryOptions(appId));
    void qc.invalidateQueries(appOpsQueryOptions(appId));
    void qc.invalidateQueries(normalizedManifestQueryOptions(appId));
    void router.invalidate();
  }, [data, fetched, appId, qc, router, t]);

  const shown = (data?.deployments ?? []).filter(
    (item) => item.status !== 'ready',
  );
  if (shown.length === 0) return null;
  return (
    <Section id="deployment-activity" title={t('deployments.request.title')}>
      <GroupCard padded>
        <Stack gap="md">
          {shown.map((deployment) => (
            <DeploymentRequest
              key={deployment.id}
              appId={appId}
              deployment={deployment}
            />
          ))}
        </Stack>
      </GroupCard>
    </Section>
  );
}
