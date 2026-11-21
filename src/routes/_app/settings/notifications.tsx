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
  return (
    <>
      <SectionHead
        title="Notifications"
        description="Where notifications from Apps and Channels are delivered. Shared by everyone in this space."
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
