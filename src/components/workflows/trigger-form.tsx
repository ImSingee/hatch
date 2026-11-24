import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { SchemaRunForm } from '~components/runs/schema-run-form';
import { workflowRunsQueryOptions } from '~queries/workflows';
import { runWorkflowFn } from '~server/workflows';

export function TriggerForm({
  workflowId,
  workflowSlug,
  inputSchema,
  disabled,
}: {
  workflowId: string;
  workflowSlug: string;
  inputSchema: unknown;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: (input: unknown) =>
      runWorkflowFn({ data: { id: workflowId, input } }),
    onSuccess: (result) => {
      // A validation failure still records a (failed) run rather than throwing,
      // so report it as an error instead of "started" — but still link to the
      // recorded run so the user can see why it was rejected.
      if (result.status === 'failed') {
        toast.error('Input rejected — see the execution for details.');
      } else {
        toast.success('Execution started');
      }
      void queryClient.invalidateQueries(workflowRunsQueryOptions(workflowId));
      void navigate({
        to: '/workflow/$workflowSlug/execution/$runId',
        params: { workflowSlug, runId: result.runId },
      });
    },
  });
  return (
    <SchemaRunForm
      formKey={workflowId}
      inputSchema={inputSchema}
      disabled={disabled}
      pending={run.isPending}
      onSubmit={(input) => run.mutate(input)}
      emptyText="This workflow takes no input."
    />
  );
}
