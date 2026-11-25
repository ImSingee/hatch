import { createFileRoute } from '@tanstack/react-router';
import { GroupCard } from '~components/page/page';
import { SectionHead } from '~components/settings/section-head';
import { TailscaleSettings } from '~components/settings/tailscale-panel';
import { useI18n } from '~i18n';
import { tailscaleQueryOptions } from '~queries/tailscale';

export const Route = createFileRoute('/_app/settings/tailscale')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(tailscaleQueryOptions),
  component: TailscaleRoute,
});

function TailscaleRoute() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.tailscale.label')}
        description={t('settings.tailscale.description')}
      />
      <GroupCard padded>
        <TailscaleSettings />
      </GroupCard>
    </>
  );
}
