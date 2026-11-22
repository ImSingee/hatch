import { createFileRoute } from '@tanstack/react-router';
import { DeskWindow } from '~components/desk/window';
import { WorkflowList } from '~components/workflows/workflow-list';
import { latestWorkflowRunsQueryOptions } from '~queries/workflows';
import { listWorkflows } from '~server/workflows';

export const Route = createFileRoute('/_app/workflows/')({
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(latestWorkflowRunsQueryOptions);
    return listWorkflows();
  },
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const workflows = Route.useLoaderData();
  return (
    <DeskWindow title="Workflows" fill>
      <WorkflowList workflows={workflows} />
    </DeskWindow>
  );
}
