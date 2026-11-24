import {
  ActionIcon,
  Code,
  Group,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconClock,
  IconCopy,
  IconHandClick,
  IconWebhook,
} from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { GroupCard, Section } from '~components/page/page';
import { formatRelative } from '~lib/format';

function TriggerHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <Group gap={8} wrap="nowrap">
      {icon}
      <Text fw={700} size="sm">
        {title}
      </Text>
    </Group>
  );
}

export type TriggerCronJob = {
  name: string;
  schedule: string;
  nextRun: string | null;
};

/**
 * How a run target is started: manually, on schedules and by webhook. The
 * caller supplies the wording for its own source contract.
 */
export function TriggersCard({
  manualNote,
  cronJobs,
  cronEmptyNote,
  webhook,
}: {
  manualNote: ReactNode;
  cronJobs: TriggerCronJob[];
  cronEmptyNote: ReactNode;
  webhook:
    | { enabled: true; url: string; secret: string | null; note: ReactNode }
    | { enabled: false; note: ReactNode };
}) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const on = 1 + (cronJobs.length > 0 ? 1 : 0) + (webhook.enabled ? 1 : 0);
  const withSecret = (url: string, secret: string | null) =>
    secret ? `${url}?secret=${secret}` : url;
  return (
    <Section id="triggers" title="Triggers" meta={`${on} of 3 on`}>
      <GroupCard padded>
        <Stack gap="lg">
          <Stack gap={6}>
            <TriggerHeader
              icon={<IconHandClick size={16} stroke={1.8} />}
              title="Manual"
            />
            <Text size="xs" c="dimmed">
              {manualNote}
            </Text>
          </Stack>

          <Stack gap={6}>
            <TriggerHeader
              icon={<IconClock size={16} stroke={1.8} />}
              title="Scheduled jobs"
            />
            {cronJobs.length === 0 ? (
              <Text size="xs" c="dimmed">
                {cronEmptyNote}
              </Text>
            ) : (
              <Table withTableBorder verticalSpacing={6} highlightOnHover>
                <Table.Tbody>
                  {cronJobs.map((job) => (
                    <Table.Tr key={job.name}>
                      <Table.Td>
                        <Text
                          size="sm"
                          fw={600}
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {job.name}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text
                          size="xs"
                          c="dimmed"
                          ff="monospace"
                          style={{ whiteSpace: 'nowrap' }}
                        >
                          {job.schedule}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" truncate>
                          {job.nextRun
                            ? `next ${formatRelative(job.nextRun)}`
                            : 'not scheduled'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>

          <Stack gap={6}>
            <TriggerHeader
              icon={<IconWebhook size={16} stroke={1.8} />}
              title="Inbound webhook"
            />
            {webhook.enabled ? (
              <>
                <Group gap={8} wrap="nowrap" align="center">
                  <Code
                    block
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 'var(--mantine-font-size-xs)',
                    }}
                  >
                    {withSecret(webhook.url, webhook.secret)}
                  </Code>
                  <Tooltip
                    label="Copy URL with secret"
                    withArrow
                    position="left"
                  >
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Copy webhook URL"
                      onClick={() => {
                        copy(
                          `${origin}${withSecret(webhook.url, webhook.secret)}`,
                        );
                        toast.success('Webhook URL copied');
                      }}
                    >
                      <IconCopy size={15} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <Text size="xs" c="dimmed">
                  {webhook.note}
                </Text>
              </>
            ) : (
              <Text size="xs" c="dimmed">
                {webhook.note}
              </Text>
            )}
          </Stack>
        </Stack>
      </GroupCard>
    </Section>
  );
}
