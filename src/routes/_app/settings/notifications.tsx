import { Center, Loader } from '@mantine/core';
import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
import { GroupCard } from '~components/page/page';
import { ChannelsSection } from '~components/notifications/channels-section';
import { DestinationsSection } from '~components/notifications/destinations-section';
import { GroupsSection } from '~components/notifications/groups-section';
import { ResponseRoutesSection } from '~components/notifications/response-routes-section';
import { RoutesSection } from '~components/notifications/routes-section';
import { SectionHead } from '~components/settings/section-head';
import { useI18n } from '~i18n';
import {
  apnsStatusQueryOptions,
  notificationChannelsQueryOptions,
  notificationDestinationsQueryOptions,
  notificationGroupsQueryOptions,
  notificationResponseRoutesQueryOptions,
  notificationRoutesQueryOptions,
  notificationSourcesQueryOptions,
} from '~queries/notifications';

export const Route = createFileRoute('/_app/settings/notifications')({
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(notificationDestinationsQueryOptions),
      queryClient.ensureQueryData(notificationGroupsQueryOptions),
      queryClient.ensureQueryData(notificationRoutesQueryOptions),
      queryClient.ensureQueryData(notificationResponseRoutesQueryOptions),
      queryClient.ensureQueryData(notificationChannelsQueryOptions),
      queryClient.ensureQueryData(notificationSourcesQueryOptions),
      queryClient.ensureQueryData(apnsStatusQueryOptions),
    ]),
  component: NotificationSettingsRoute,
});

function NotificationSettingsRoute() {
  const { t } = useI18n();
  return (
    <>
      <SectionHead
        title={t('settings.notifications.label')}
        description={t('notifications.settings.description')}
      />
      <Suspense
        fallback={
          <Center py="xl">
            <Loader />
          </Center>
        }
      >
        <GroupCard padded>
          <DestinationsSection />
        </GroupCard>
        <GroupCard padded>
          <GroupsSection />
        </GroupCard>
        <GroupCard padded>
          <RoutesSection />
        </GroupCard>
        <GroupCard padded>
          <ResponseRoutesSection />
        </GroupCard>
        <GroupCard padded>
          <ChannelsSection />
        </GroupCard>
      </Suspense>
    </>
  );
}
