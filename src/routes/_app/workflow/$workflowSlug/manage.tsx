import {
  ActionIcon,
  Anchor,
  Group,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from '@tanstack/react-router';
import { IconCheck, IconPencil, IconX } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import dayjs from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { WORKFLOW_SLUG_MAX_LENGTH } from '~/workflow-identity';
import {
  Column,
  Columns,
  GroupCard,
  GroupFooter,
  Row,
  Section,
} from '~components/page/page';
import { WorkflowDeploymentHistory } from '~components/workflows/deployment-history';
import { WorkflowNetworkPermissionsPanel } from '~components/workflows/network-permissions-panel';
import { WorkflowCompatibilityNotice } from '~components/workflows/workflow-compatibility-notice';
import { WorkflowTriggersPanel } from '~components/workflows/triggers-panel';
import { WorkflowWindow } from '~components/workflows/workflow-window';
import { workflowsQueryOptions } from '~queries/workflows';
import { getWorkflowBySlug, setWorkflowSlugFn } from '~server/workflows';

export const Route = createFileRoute('/_app/workflow/$workflowSlug/manage')({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
    if (!workflow) throw notFound();
    return workflow;
  },
  component: WorkflowManagePage,
});

function WorkflowManagePage() {
  const workflow = Route.useLoaderData();

  return (
    <WorkflowWindow workflow={workflow} page="manage">
      <WorkflowCompatibilityNotice compatibility={workflow.compatibility} />
      <Columns>
        <Column grow basis={420}>
          <Section id="overview" title="Overview">
            <GroupCard>
              <Row label="Name">
                <strong>{workflow.name}</strong>
              </Row>
              <WorkflowSlugField id={workflow.id} slug={workflow.slug} />
              <Row label="Workflow ID" mono>
                <CopyValue value={workflow.id} />
              </Row>
              <Row label="Updated">
                {dayjs(workflow.updatedAt).format('YYYY-MM-DD HH:mm')}
              </Row>
              <Row label="Dock">
                {workflow.pinned ? 'Pinned' : 'Not pinned'}
              </Row>
              <GroupFooter>
                <span>
                  Continue editing this workflow from the{' '}
                  <Anchor component={Link} to="/agent" size="sm">
                    Agent
                  </Anchor>
                  .
                </span>
              </GroupFooter>
            </GroupCard>
          </Section>
          <WorkflowTriggersPanel workflowId={workflow.id} />
          <WorkflowNetworkPermissionsPanel workflowId={workflow.id} />
        </Column>
        <Column basis={360}>
          <WorkflowDeploymentHistory workflowId={workflow.id} />
        </Column>
      </Columns>
    </WorkflowWindow>
  );
}

/** A value that copies itself when clicked. */
function CopyValue({ value }: { value: string }) {
  return (
    <Tooltip label="Copy" withArrow position="top">
      <UnstyledButton
        onClick={() => {
          copy(value);
          toast.success('Copied');
        }}
        ff="monospace"
        fz="xs"
      >
        {value}
      </UnstyledButton>
    </Tooltip>
  );
}

function WorkflowSlugField({ id, slug }: { id: string; slug: string }) {
  const router = useRouter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slug);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = useMutation({
    mutationFn: (next: string) =>
      setWorkflowSlugFn({ data: { id, slug: next } }),
    onSuccess: (result) => {
      toast.success(`URL slug is now "${result.slug}"`);
      setEditing(false);
      void navigate({
        to: '/workflow/$workflowSlug/manage',
        params: { workflowSlug: result.slug },
        search: true,
        hash: true,
        replace: true,
      }).then(async () => {
        await queryClient.invalidateQueries(workflowsQueryOptions);
        await router.invalidate();
      });
    },
  });

  const submit = () => {
    const next = draft.trim();
    if (next === slug) {
      setEditing(false);
      return;
    }
    save.mutate(next);
  };

  return (
    <Row label="URL slug">
      {editing ? (
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            ref={inputRef}
            value={draft}
            maxLength={WORKFLOW_SLUG_MAX_LENGTH}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape') {
                setDraft(slug);
                setEditing(false);
              }
            }}
            size="xs"
            disabled={save.isPending}
            styles={{ input: { fontFamily: 'monospace' } }}
            style={{ flex: 1, minWidth: 160 }}
          />
          <Tooltip label="Save" withArrow position="top">
            <ActionIcon
              variant="light"
              color="green"
              onClick={submit}
              loading={save.isPending}
              aria-label="Save slug"
            >
              <IconCheck size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Cancel" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(false);
              }}
              disabled={save.isPending}
              aria-label="Cancel"
            >
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ) : (
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" ff="monospace" truncate>
            {slug}
          </Text>
          <Tooltip label="Edit slug" withArrow position="top">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => {
                setDraft(slug);
                setEditing(true);
              }}
              aria-label="Edit slug"
            >
              <IconPencil size={15} />
            </ActionIcon>
          </Tooltip>
        </Group>
      )}
    </Row>
  );
}
