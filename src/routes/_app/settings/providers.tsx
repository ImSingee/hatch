import { Button, Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { IconPlus } from '@tabler/icons-react';
import { Suspense, useState } from 'react';
import { SectionHead } from '~components/settings/section-head';
import {
  ProviderFormModal,
  ProvidersPanel,
} from '~components/settings/providers-panel';
import { useI18n } from '~i18n';
import { providersQueryOptions } from '~queries/agent';

export const Route = createFileRoute('/_app/settings/providers')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(providersQueryOptions),
  component: ProvidersRoute,
});

function ProvidersRoute() {
  const { t } = useI18n();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <SectionHead
        title={t('settings.providers.label')}
        description={t('settings.providers.description')}
        action={
          <Button
            leftSection={<IconPlus size={16} stroke={1.8} />}
            onClick={() => setCreateOpen(true)}
          >
            {t('providers.addProvider')}
          </Button>
        }
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <ProvidersPanel onAddProvider={() => setCreateOpen(true)} />
      </Suspense>

      {createOpen && (
        <ProviderFormModal opened onClose={() => setCreateOpen(false)} />
      )}
    </>
  );
}
