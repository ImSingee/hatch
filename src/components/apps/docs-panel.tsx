import {
  ActionIcon,
  Center,
  Code,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { useState } from 'react';
import { toast } from 'sonner';
import type { PublishedAppDoc } from '~server/apps/manifest';
import {
  appDocQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { Markdownish } from '~components/agent/markdownish';
import { GroupCard, Section } from '~components/page/page';

function DocBody({ appId, doc }: { appId: string; doc: PublishedAppDoc }) {
  const query = useQuery(appDocQueryOptions(appId, doc.id, doc.sha256));
  if (query.isLoading) {
    return (
      <Center py="lg">
        <Loader size="sm" />
      </Center>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Text size="sm" c="red">
        {query.error instanceof Error
          ? query.error.message
          : 'This doc could not be loaded.'}
      </Text>
    );
  }
  return <Markdownish text={query.data.content} math={false} />;
}

function CliCommand({ command }: { command: string }) {
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Code style={{ fontSize: 'var(--mantine-font-size-xs)' }}>{command}</Code>
      <Tooltip label="Copy command" withArrow position="top">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="Copy command"
          onClick={() => {
            copy(command);
            toast.success('Command copied');
          }}
        >
          <IconCopy size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

/**
 * The external docs the current deployment publishes for services that call
 * this App. Self-hides when the deployment publishes none.
 */
export function DocsPanel({ appId, slug }: { appId: string; slug: string }) {
  const { data: manifest } = useQuery(normalizedManifestQueryOptions(appId));
  const docs = manifest?.docs ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  if (docs.length === 0) return null;
  const active = docs.find((doc) => doc.id === selected) ?? docs[0];

  return (
    <Section
      id="docs"
      title="Docs"
      meta={`${docs.length} published`}
      note="Published with the current deployment for services that call this App. Readable with the hatch CLI."
    >
      <GroupCard padded>
        <Stack gap="md">
          <Tabs value={active.id} onChange={setSelected} variant="pills">
            <Tabs.List>
              {docs.map((doc) => (
                <Tabs.Tab key={doc.id} value={doc.id}>
                  {doc.title}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs>
          <Stack gap={4}>
            {active.description ? (
              <Text size="sm" c="dimmed">
                {active.description}
              </Text>
            ) : null}
            <CliCommand command={`hatch app docs get ${slug} ${active.id}`} />
          </Stack>
          <DocBody key={active.id} appId={appId} doc={active} />
        </Stack>
      </GroupCard>
    </Section>
  );
}
