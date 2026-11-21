import { createFileRoute, notFound } from '@tanstack/react-router';
import { WindowPage } from '~components/desk/window-page';
import { AppGlyph } from '~components/apps/app-glyph';
import { WorkflowRunList } from '~components/workflows/run-list';
import { StatusBadge } from '~components/system/status-badge';
import { WorkflowTabs } from '~components/workflows/workflow-tabs';
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
    <WindowPage
      title={`${workflow.name} · Executions`}
      tile={
        <AppGlyph
          icon={false}
          name={workflow.name}
          seed={workflow.id}
          size="sm"
        />
      }
      badge={<StatusBadge status={workflow.status} />}
      closeTo={{ link: { to: '/workflows' }, label: 'Workflows' }}
      description="Execution history"
      actions={<WorkflowTabs slug={workflow.slug} active="executions" />}
    >
      <WorkflowRunList workflowId={workflow.id} workflowSlug={workflow.slug} />
    </WindowPage>
  );
}
