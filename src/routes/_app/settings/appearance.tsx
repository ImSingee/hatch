import { createFileRoute } from '@tanstack/react-router';
import { GroupCard } from '~components/page/page';
import { AccentPanel } from '~components/settings/accent-panel';
import { DockLabelsPanel } from '~components/settings/dock-labels-panel';
import { LanguagePanel } from '~components/settings/language-panel';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { themeQueryOptions } from '~queries/theme';
import { getThemeFn } from '~server/theme';

export const Route = createFileRoute('/_app/settings/appearance')({
  // The theme names the user it belongs to, which keys the cached copy the
  // panels read.
  loader: async ({ context }) => {
    const theme = await getThemeFn();
    context.queryClient.setQueryData(
      themeQueryOptions(theme.userId).queryKey,
      theme,
    );
    return { userId: theme.userId };
  },
  component: AppearanceSettings,
});

function AppearanceSettings() {
  const { t } = useI18n();
  const { userId } = Route.useLoaderData();
  return (
    <>
      <SectionHead
        title={t('settings.appearance.label')}
        description={t('appearance.description')}
      />
      <GroupCard padded>
        <AccentPanel userId={userId} />
      </GroupCard>
      <GroupCard padded>
        <DockLabelsPanel userId={userId} />
      </GroupCard>
      <GroupCard padded>
        <LanguagePanel />
      </GroupCard>
    </>
  );
}
