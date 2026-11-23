import { createFileRoute, notFound } from '@tanstack/react-router';
import { WorkflowRunList } from '~components/workflows/run-list';
import { WorkflowWindow } from '~components/workflows/workflow-window';
import { getWorkflowBySlug } from '~server/workflows';

export const Route = createFileRoute(
  '/_app/workflow/$workflowSlug/executions/',
)({
  loader: async ({ params }) => {
    const workflow = await getWorkflowBySlug({ data: params.workflowSlug });
    if (!workflow) throw notFound();
    return workflow;
  },
  component: WorkflowExecutionsPage,
});

function WorkflowExecutionsPage() {
  const workflow = Route.useLoaderData();

  return (
    <WorkflowWindow workflow={workflow} page="executions">
      <WorkflowRunList workflowId={workflow.id} workflowSlug={workflow.slug} />
    </WorkflowWindow>
  );
}
