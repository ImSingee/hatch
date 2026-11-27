import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { BuilderPanel } from '~components/settings/builder-panel';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import { builderOverviewQueryOptions } from '~queries/apps';

export const Route = createFileRoute('/_app/settings/builder')({
  // Warm the cache without blocking navigation: the panel suspends on it.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(builderOverviewQueryOptions);
  },
  component: BuilderRoute,
});

function BuilderRoute() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.builder.label')}
        description={t('settings.builder.description')}
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <BuilderPanel />
      </Suspense>
    </>
  );
}
