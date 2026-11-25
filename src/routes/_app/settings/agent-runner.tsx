import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { GroupCard } from '~components/page/page';
import { AgentRunnerPanel } from '~components/settings/agent-runner-panel';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { agentRunnerStatusQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/settings/agent-runner')({
  // Warm the cache without blocking navigation: the panel owns its own
  // skeleton and error states, so a slow or failing status probe must not
  // keep the whole settings page from opening.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(agentRunnerStatusQueryOptions);
  },
  component: AgentRunnerRoute,
});

function AgentRunnerRoute() {
  const { t } = useI18n();
  const query = useQuery(agentRunnerStatusQueryOptions);
  return (
    <>
      <SectionHead
        title={t('settings.agentRunner.label')}
        description={t('settings.agentRunner.description')}
      />
      <GroupCard padded>
        <AgentRunnerPanel
          snapshot={query.data}
          isLoading={query.isPending}
          error={query.error}
          onRefresh={() => query.refetch()}
        />
      </GroupCard>
    </>
  );
}
