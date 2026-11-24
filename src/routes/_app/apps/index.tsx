import { createFileRoute } from '@tanstack/react-router';
import { AppLibrary } from '~components/apps/app-library';
import { DeskWindow } from '~components/desk/window';
import { useI18n } from '~i18n';
import { listApps } from '~server/apps';

export const Route = createFileRoute('/_app/apps/')({
  loader: () => listApps(),
  component: AppsPage,
});

function AppsPage() {
  const { t } = useI18n();
  const apps = Route.useLoaderData();
  return (
    <DeskWindow title={t('nav.allApps')} fill>
      <AppLibrary apps={apps} />
    </DeskWindow>
  );
}
