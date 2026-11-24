import { createFileRoute } from '@tanstack/react-router';
import { GroupCard } from '~components/page/page';
import { AboutPanel } from '~components/settings/about-panel';
import { SectionHead } from '~components/settings/section-head';
import { serverInfoQueryOptions } from '~queries/server-info';

export const Route = createFileRoute('/_app/settings/about')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(serverInfoQueryOptions),
  component: AboutRoute,
});

function AboutRoute() {
  return (
    <>
      <SectionHead
        title="About"
        description="Source revision used to build this platform."
      />
      <GroupCard padded>
        <AboutPanel />
      </GroupCard>
    </>
  );
}
