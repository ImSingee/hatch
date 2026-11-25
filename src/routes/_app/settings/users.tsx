import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { GroupCard } from '~components/page/page';
import { SectionHead } from '~components/settings/section-head';
import { UsersPanel } from '~components/settings/users-panel';
import { useI18n } from '~i18n';
import { usersPanelQueryOptions } from '~queries/users';

export const Route = createFileRoute('/_app/settings/users')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(usersPanelQueryOptions),
  component: UsersRoute,
});

function UsersRoute() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.users.label')}
        description={t('settings.users.description')}
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <GroupCard padded>
          <UsersPanel />
        </GroupCard>
      </Suspense>
    </>
  );
}
