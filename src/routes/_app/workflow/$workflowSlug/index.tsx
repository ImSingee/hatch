import { Alert, Anchor, Stack } from '@mantine/core';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { IconInfoCircle } from '@tabler/icons-react';
import {
  Callout,
  Column,
  Columns,
  GroupCard,
  Section,
} from '~components/page/page';
import { WorkflowRunList } from '~components/workflows/run-list';
import { WorkflowTriggersPanel } from '~components/workflows/triggers-panel';
import { WorkflowWindow } from '~components/workflows/workflow-window';
import { TriggerForm } from '~components/workflows/trigger-form';
import { WorkflowCompatibilityNotice } from '~components/workflows/workflow-compatibility-notice';
import { getWorkflowBySlug } from '~server/workflows';

export const Route = createFileRoute('/_app/workflow/$workflowSlug/')({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
    if (!workflow) throw notFound();
    return workflow;
  },
  component: WorkflowRunPage,
});

/**
 * The "run" surface (opened from the dock): the inferred input form, the
 * latest executions and how the workflow is triggered.
 */
export function WorkflowRunPage() {
  const workflow = Route.useLoaderData();
  const isDeployed = workflow.status === 'deployed';
  const runtimeSupported = workflow.compatibility?.isSupported === true;

  return (
    <WorkflowWindow workflow={workflow} page="run">
      <Columns>
        <Column grow basis={420}>
          <Section
            title="Run it now"
            note="The form is built from the workflow’s inputs. Every run is recorded under Executions."
          >
            {isDeployed && runtimeSupported ? (
              <GroupCard padded>
                <TriggerForm
                  workflowId={workflow.id}
                  workflowSlug={workflow.slug}
                  inputSchema={workflow.inputSchema}
                />
              </GroupCard>
            ) : isDeployed ? (
              <Stack>
                <WorkflowCompatibilityNotice
                  compatibility={workflow.compatibility}
                />
                {!workflow.compatibility ? (
                  <Alert
                    color="red"
                    variant="light"
                    icon={<IconInfoCircle size={16} />}
                  >
                    The active deployment record is unavailable. Redeploy this
                    Workflow from the Agent before running it.
                  </Alert>
                ) : null}
              </Stack>
            ) : (
              <Alert
                color="primary"
                variant="light"
                icon={<IconInfoCircle size={16} />}
              >
                This workflow isn&apos;t deployed yet. Deploy it from the Agent
                to enable manual, cron, and webhook triggers.
              </Alert>
            )}
          </Section>
          <WorkflowRunList
            workflowId={workflow.id}
            workflowSlug={workflow.slug}
            limit={5}
          />
        </Column>
        <Column basis={320}>
          <WorkflowTriggersPanel workflowId={workflow.id} />
          <Callout title="Want it to work differently?">
            A workflow is code with no editor of its own. Tell the Agent what to
            change and it updates and redeploys it.
            <Anchor component={Link} to="/agent" size="sm">
              Edit with the Agent ›
            </Anchor>
          </Callout>
        </Column>
      </Columns>
    </WorkflowWindow>
  );
}
