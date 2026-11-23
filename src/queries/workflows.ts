import { queryOptions } from '@tanstack/react-query';
import {
  getWorkflowDeploymentBuildLog,
  getWorkflowOps,
  getWorkflowRun,
  listAllWorkflowRuns,
  listLatestRunPerWorkflow,
  listWorkflowDeployments,
  listWorkflowRuns,
  listWorkflows,
} from '~server/workflows';

export const workflowsQueryOptions = queryOptions({
  queryKey: ['workflows'],
  queryFn: () => listWorkflows(),
});

export const workflowDeploymentsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['workflows', id, 'deployments'],
    queryFn: () => listWorkflowDeployments({ data: id }),
  });

export const workflowDeploymentBuildLogQueryOptions = (
  workflowId: string,
  deploymentId: string,
) =>
  queryOptions({
    queryKey: ['workflows', workflowId, 'deployments', deploymentId, 'log'],
    queryFn: () =>
      getWorkflowDeploymentBuildLog({ data: { id: workflowId, deploymentId } }),
    // A deployment's build log is immutable, so never refetch once loaded.
    staleTime: Number.POSITIVE_INFINITY,
  });

export const workflowOpsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['workflows', id, 'ops'],
    queryFn: () => getWorkflowOps({ data: id }),
  });

export const workflowRunsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['workflows', id, 'runs'],
    queryFn: () => listWorkflowRuns({ data: id }),
  });

/** The newest execution of each workflow, under the `workflow-runs` key so
 * the same invalidations refresh it. */
export const latestWorkflowRunsQueryOptions = queryOptions({
  queryKey: ['workflow-runs', 'latest'],
  queryFn: () => listLatestRunPerWorkflow(),
});

export const allWorkflowRunsQueryOptions = queryOptions({
  queryKey: ['workflow-runs', 'all'],
  queryFn: () => listAllWorkflowRuns(),
});

export const workflowRunQueryOptions = (runId: string) =>
  queryOptions({
    queryKey: ['workflow-run', runId],
    queryFn: () => getWorkflowRun({ data: runId }),
  });
