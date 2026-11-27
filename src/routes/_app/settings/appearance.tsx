import { createFileRoute } from '@tanstack/react-router';
import { GroupCard } from '~components/page/page';
import { AccentPanel } from '~components/settings/accent-panel';
import { DockLabelsPanel } from '~components/settings/dock-labels-panel';
import { LanguagePanel } from '~components/settings/language-panel';
import { SectionHead } from '~components/settings/section-head';
import { ThemeLibraryPanel } from '~components/settings/theme-panel';
import { useI18n } from '~i18n';
import { themeQueryOptions, themesQueryOptions } from '~queries/theme';

export const Route = createFileRoute('/_app/settings/appearance')({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(themeQueryOptions),
      context.queryClient.ensureQueryData(themesQueryOptions),
    ]),
  component: AppearanceSettings,
});

function AppearanceSettings() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.appearance.label')}
        description={t('appearance.description')}
      />
      <GroupCard padded>
        <ThemeLibraryPanel />
      </GroupCard>
      <GroupCard padded>
        <AccentPanel />
      </GroupCard>
      <GroupCard padded>
        <DockLabelsPanel />
      </GroupCard>
      <GroupCard padded>
        <LanguagePanel />
      </GroupCard>
    </>
  );
}
