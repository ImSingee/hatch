import { Center, Code, Loader } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { GroupCard, Section } from '~components/page/page';
import { TriggersCard } from '~components/runs/triggers-card';
import { workflowOpsQueryOptions } from '~queries/workflows';

export function WorkflowTriggersPanel({ workflowId }: { workflowId: string }) {
  const query = useQuery(workflowOpsQueryOptions(workflowId));

  if (query.isLoading) {
    return (
      <Section id="triggers" title="Triggers">
        <GroupCard padded>
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        </GroupCard>
      </Section>
    );
  }

  const ops = query.data;
  if (!ops) return null;

  return (
    <TriggersCard
      manualNote={
        <>
          Trigger on demand from the workflow&apos;s Run page; inputs are
          validated against its schema before the run starts.
        </>
      }
      cronJobs={ops.cron.jobs}
      cronEmptyNote="No cron jobs declared in the manifest."
      webhook={
        ops.webhook.enabled
          ? {
              enabled: true,
              url: ops.webhook.url ?? '',
              secret: ops.webhook.secret ?? '',
              note: 'POST a JSON body (or GET with query params) here; the platform verifies the secret and starts a run with it as input.',
            }
          : {
              enabled: false,
              note: (
                <>
                  Webhook trigger is disabled. Enable it in the manifest (
                  <Code>triggers.webhook</Code>) and redeploy.
                </>
              ),
            }
      }
    />
  );
}
