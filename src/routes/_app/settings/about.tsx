import { createFileRoute } from '@tanstack/react-router';
import { GroupCard } from '~components/page/page';
import { AboutPanel } from '~components/settings/about-panel';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { serverInfoQueryOptions } from '~queries/server-info';

export const Route = createFileRoute('/_app/settings/about')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(serverInfoQueryOptions),
  component: AboutRoute,
});

function AboutRoute() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.about.label')}
        description={t('settings.about.description')}
      />
      <GroupCard padded>
        <AboutPanel />
      </GroupCard>
    </>
  );
}
