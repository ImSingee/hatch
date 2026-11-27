import {
  Center,
  Loader,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PublishedAppDoc } from '~server/apps/manifest';
import {
  StaleAppDocError,
  appDocQueryOptions,
  normalizedManifestQueryOptions,
} from '~queries/apps';
import { useI18n } from '~i18n';
import { Markdownish } from '~components/agent/markdownish';
import { GroupCard, Section } from '~components/page/page';
import { CliCommand } from './cli-command';

function DocBody({ appId, doc }: { appId: string; doc: PublishedAppDoc }) {
  const { t } = useI18n();
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
        {query.error instanceof StaleAppDocError
          ? t('appDocs.stale')
          : t('appDocs.loadFailed')}
      </Text>
    );
  }
  return <Markdownish text={query.data.content} math={false} />;
}

/**
 * The external docs the current deployment publishes for services that call
 * this App. Self-hides when the deployment publishes none.
 */
export function DocsPanel({ appId, slug }: { appId: string; slug: string }) {
  const { t } = useI18n();
  const { data: manifest } = useQuery(normalizedManifestQueryOptions(appId));
  const docs = manifest?.docs ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  if (docs.length === 0) return null;
  const active = docs.find((doc) => doc.id === selected) ?? docs[0];

  return (
    <Section
      id="docs"
      title={t('appDocs.title')}
      meta={t('appDocs.published', { count: docs.length })}
      note={t('appDocs.note')}
    >
      <GroupCard padded>
        <Stack gap="md">
          {/* Scrolls sideways instead of widening the page for long titles. */}
          <ScrollArea type="auto" scrollbarSize={6} offsetScrollbars="x">
            <SegmentedControl
              aria-label={t('appDocs.selector')}
              value={active.id}
              onChange={setSelected}
              data={docs.map((doc) => ({ value: doc.id, label: doc.title }))}
            />
          </ScrollArea>
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
