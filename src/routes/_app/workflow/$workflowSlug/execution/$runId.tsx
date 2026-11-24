import { Anchor, Button } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { IconPlayerStop } from '@tabler/icons-react';
import { toast } from 'sonner';
import { AppGlyph } from '~components/apps/app-glyph';
import { DeskWindow } from '~components/desk/window';
import { Toolbar, WindowBody } from '~components/page/page';
import { RunInspector } from '~components/runs/run-inspector';
import { RunStatusBadge } from '~components/runs/run-status';
import {
  workflowRunQueryOptions,
  workflowRunsQueryOptions,
} from '~queries/workflows';
import {
  cancelWorkflowRunFn,
  getWorkflowBySlug,
  getWorkflowRun,
} from '~server/workflows';

export const Route = createFileRoute(
  '/_app/workflow/$workflowSlug/execution/$runId',
)({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
    if (!workflow) throw notFound();
    const run = await getWorkflowRun({ data: params.runId });
    // Scope the run to its workflow so a deep link like
    // /workflow/<A>/execution/<run-of-B> can't render or cancel B under A.
    if (!run || run.workflowId !== workflow.id) throw notFound();
    return { run, workflow };
  },
  component: WorkflowExecutionPage,
});

function WorkflowExecutionPage() {
  const initial = Route.useLoaderData();
  const { runId } = Route.useParams();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    ...workflowRunQueryOptions(runId),
    initialData: initial.run,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === 'queued' || status === 'running' ? 1200 : false;
    },
  });
  const run = data ?? initial.run;
  const { workflow } = initial;
  const active = run.status === 'queued' || run.status === 'running';

  const cancel = useMutation({
    mutationFn: () => cancelWorkflowRunFn({ data: runId }),
    onSuccess: () => {
      toast.success('Execution canceled');
      void queryClient.invalidateQueries(workflowRunQueryOptions(runId));
      void queryClient.invalidateQueries(workflowRunsQueryOptions(workflow.id));
    },
  });

  return (
    <DeskWindow
      fill
      maxWidth={1180}
      title={`${workflow.name} · Execution`}
      tile={
        <AppGlyph
          icon={false}
          shape="workflow"
          name={workflow.name}
          seed={workflow.id}
          size="sm"
        />
      }
      badge={<RunStatusBadge status={run.status} />}
      closeTo={{
        link: {
          to: '/workflow/$workflowSlug/executions',
          params: { workflowSlug: workflow.slug },
        },
        label: "this workflow's executions",
      }}
    >
      <WindowBody>
        <Toolbar
          lead={
            <Anchor
              size="sm"
              underline="never"
              renderRoot={(props) => (
                <Link
                  to="/workflow/$workflowSlug/executions"
                  params={{ workflowSlug: workflow.slug }}
                  {...props}
                />
              )}
            >
              ‹ All executions of {workflow.name}
            </Anchor>
          }
        >
          {active ? (
            <Button
              color="red"
              variant="light"
              leftSection={<IconPlayerStop size={16} stroke={1.8} />}
              loading={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          ) : null}
        </Toolbar>
        <RunInspector
          run={run}
          emptyStepsText="This execution recorded no steps."
        />
      </WindowBody>
    </DeskWindow>
  );
}
