import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { GroupCard } from '~components/page/page';
import { BackendsPanel } from '~components/apps/backends-panel';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { appBackendsQueryOptions } from '~queries/apps';

export const Route = createFileRoute('/_app/settings/backends')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(appBackendsQueryOptions),
  component: BackendsRoute,
});

function BackendsRoute() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.backends.label')}
        description={t('settings.backends.description')}
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <GroupCard padded>
          <BackendsPanel />
        </GroupCard>
      </Suspense>
    </>
  );
}
