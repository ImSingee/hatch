import { Center, Loader, Text } from '@mantine/core';
import { GroupCard, Section } from '~components/page/page';
import { useQuery } from '@tanstack/react-query';
import { ExtraPermissionsDetails } from '~components/system/extra-permissions';
import { NetworkAccessDetails } from '~components/system/network-access';
import { workflowOpsQueryOptions } from '~queries/workflows';

export function WorkflowNetworkPermissionsPanel({
  workflowId,
}: {
  workflowId: string;
}) {
  const query = useQuery(workflowOpsQueryOptions(workflowId));

  return (
    <Section id="permissions" title="Permissions">
      <GroupCard padded>
        {query.isLoading ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : query.data ? (
          <>
            <NetworkAccessDetails access={query.data.network} />
            <Text fw={600} mt="md" mb="xs">
              Extra permissions
            </Text>
            <ExtraPermissionsDetails access={query.data.extraPermissions} />
          </>
        ) : null}
      </GroupCard>
    </Section>
  );
}
