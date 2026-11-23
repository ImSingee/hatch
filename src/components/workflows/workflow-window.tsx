import { ActionIcon, Badge, Button, Menu, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import {
  IconArchive,
  IconArchiveOff,
  IconDots,
  IconFileCode,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlayerPlay,
  IconSettings,
  IconSparkles,
  IconTimeline,
  IconTrash,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { DeskWindow, type WindowTarget } from '~components/desk/window';
import { LinkTabs, WindowBody } from '~components/page/page';
import { StatusBadge } from '~components/system/status-badge';
import { formatRelative } from '~lib/format';
import {
  workflowOpsQueryOptions,
  workflowsQueryOptions,
} from '~queries/workflows';
import {
  archiveWorkflowFn,
  deleteWorkflowFn,
  setWorkflowPinFn,
  type WorkflowDetail,
} from '~server/workflows';
import classes from './workflow-window.module.css';

export type WorkflowPage = 'run' | 'executions' | 'manage';

const TO_WORKFLOWS: WindowTarget = {
  link: { to: '/workflows' },
  label: 'Workflows',
};

/**
 * The window of one Workflow: who it is, what can be done with it, and its
 * pages (Run, Executions, Manage) as tabs. Each page is its own route.
 */
export function WorkflowWindow({
  workflow,
  page,
  children,
}: {
  workflow: WorkflowDetail;
  page: WorkflowPage;
  children: ReactNode;
}) {
  const params = { workflowSlug: workflow.slug };
  return (
    <DeskWindow
      fill
      title={workflow.name}
      tile={
        <AppGlyph
          icon={false}
          shape="workflow"
          name={workflow.name}
          seed={workflow.id}
          size="sm"
        />
      }
      badge={<StatusBadge status={workflow.status} />}
      toolbar={<WorkflowActionsMenu workflow={workflow} />}
      closeTo={TO_WORKFLOWS}
    >
      <WindowBody>
        <header className={classes.header}>
          <AppGlyph
            icon={false}
            shape="workflow"
            name={workflow.name}
            seed={workflow.id}
            size="hero"
          />
          <div className={classes.identity}>
            <div className={classes.nameRow}>
              <h2 className={classes.name}>{workflow.name}</h2>
              {workflow.pinned ? (
                <Badge
                  color="dark"
                  variant="filled"
                  leftSection={<IconPinFilled size={10} />}
                >
                  Pinned
                </Badge>
              ) : null}
            </div>
            {workflow.description ? (
              <p className={classes.description}>{workflow.description}</p>
            ) : null}
            <span className={classes.meta}>
              Workflow · {workflow.slug} · Updated{' '}
              {formatRelative(workflow.updatedAt)}
            </span>
          </div>
          <div className={classes.actions}>
            <Button
              size="md"
              variant="default"
              component={Link}
              to="/agent"
              leftSection={<IconSparkles size={16} stroke={1.8} />}
            >
              Edit with the Agent
            </Button>
            {page !== 'run' ? (
              <Button
                size="md"
                leftSection={<IconPlayerPlay size={16} stroke={1.8} />}
                renderRoot={(props) => (
                  <Link
                    to="/workflow/$workflowSlug"
                    params={params}
                    {...props}
                  />
                )}
              >
                Run
              </Button>
            ) : null}
          </div>
        </header>
        <LinkTabs
          label="Workflow pages"
          tabs={[
            {
              key: 'run',
              label: 'Run',
              icon: <IconPlayerPlay size={16} stroke={1.8} />,
              link: { to: '/workflow/$workflowSlug', params },
              current: page === 'run',
            },
            {
              key: 'executions',
              label: 'Executions',
              icon: <IconTimeline size={16} stroke={1.8} />,
              link: { to: '/workflow/$workflowSlug/executions', params },
              current: page === 'executions',
            },
            {
              key: 'manage',
              label: 'Manage',
              icon: <IconSettings size={16} stroke={1.8} />,
              link: { to: '/workflow/$workflowSlug/manage', params },
              current: page === 'manage',
            },
          ]}
        />
        {children}
      </WindowBody>
    </DeskWindow>
  );
}

/** Download, pin, archive and delete, from the window's title bar. */
function WorkflowActionsMenu({ workflow }: { workflow: WorkflowDetail }) {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isArchived = workflow.status === 'archived';
  const isPinned = Boolean(workflow.pinned);
  const hasCurrent = Boolean(workflow.currentDeploymentId);

  const archive = useMutation({
    mutationFn: (archived: boolean) =>
      archiveWorkflowFn({ data: { id: workflow.id, archived } }),
    onSuccess: (_result, archived) => {
      toast.success(archived ? 'Workflow archived' : 'Workflow restored');
      // Archiving flips webhook/cron availability; refresh the ops query the
      // Triggers panel reads so it doesn't keep showing a now-dead webhook.
      void queryClient.invalidateQueries(workflowOpsQueryOptions(workflow.id));
      void queryClient.invalidateQueries(workflowsQueryOptions);
      void router.invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteWorkflowFn({ data: workflow.id }),
    onSuccess: () => {
      toast.success(`Deleted ${workflow.name}`);
      void queryClient.invalidateQueries(workflowsQueryOptions);
      void navigate({ to: '/workflows' });
    },
  });

  const pin = useMutation({
    mutationFn: (pinned: boolean) =>
      setWorkflowPinFn({ data: { id: workflow.id, pinned } }),
    onSuccess: (_result, pinned) => {
      toast.success(pinned ? 'Pinned to the dock' : 'Removed from the dock');
      void queryClient.invalidateQueries(workflowsQueryOptions);
      void router.invalidate();
    },
  });

  const confirmDelete = () =>
    modals.openConfirmModal({
      title: `Delete ${workflow.name}?`,
      children: (
        <Text size="sm">
          This permanently removes the workflow, all deployments, and its run
          history. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete workflow', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(),
    });

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          variant="light"
          color="gray"
          size={30}
          radius="sm"
          aria-label="More actions"
        >
          <IconDots size={16} stroke={2} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Download</Menu.Label>
        <Menu.Item
          leftSection={<IconFileCode size={16} />}
          component="a"
          href={`/api/workflow/${workflow.id}/download?deployment=${
            workflow.currentDeploymentId ?? ''
          }`}
          download
          disabled={!hasCurrent}
        >
          Live bundle (.js)
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={
            isPinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />
          }
          onClick={() => pin.mutate(!isPinned)}
        >
          {isPinned ? 'Remove from dock' : 'Pin to dock'}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          leftSection={
            isArchived ? (
              <IconArchiveOff size={16} />
            ) : (
              <IconArchive size={16} />
            )
          }
          onClick={() => archive.mutate(!isArchived)}
        >
          {isArchived ? 'Restore from archive' : 'Archive'}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={16} />}
          onClick={confirmDelete}
        >
          Delete workflow
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
