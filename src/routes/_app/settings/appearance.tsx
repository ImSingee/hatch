import { createFileRoute } from '@tanstack/react-router';
import { GroupCard } from '~components/page/page';
import { AccentPanel } from '~components/settings/accent-panel';
import { DockLabelsPanel } from '~components/settings/dock-labels-panel';
import { SectionHead } from '~components/settings/section-head';
import { themeQueryOptions } from '~queries/theme';

export const Route = createFileRoute('/_app/settings/appearance')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(themeQueryOptions),
  component: () => (
    <>
      <SectionHead
        title="Appearance"
        description="How Hatch looks for everyone on this instance, on the web and in the apps."
      />
      <GroupCard padded>
        <AccentPanel />
      </GroupCard>
      <GroupCard padded>
        <DockLabelsPanel />
      </GroupCard>
    </>
  ),
});
