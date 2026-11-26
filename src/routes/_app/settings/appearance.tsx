import { createFileRoute } from '@tanstack/react-router';
import { AppearancePanels } from '~components/settings/appearance-panels';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { themeQueryOptions } from '~queries/theme';
import { getThemeFn } from '~server/theme';

export const Route = createFileRoute('/_app/settings/appearance')({
  // Warms the cached copy the panels read; the theme names its user, which
  // keys that copy. The panels themselves follow the live session.
  loader: async ({ context }) => {
    const theme = await getThemeFn();
    context.queryClient.setQueryData(
      themeQueryOptions(theme.userId).queryKey,
      theme,
    );
  },
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
      <AppearancePanels />
    </>
  );
}
