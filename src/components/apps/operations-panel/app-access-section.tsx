import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { IconPlugConnected } from '@tabler/icons-react';
import type { PlainTranslationKey } from '~i18n';
import { useI18n } from '~i18n';
import type { AppOps } from '~server/apps';
import { SectionHeader } from './section-header';

type Overview = AppOps['appAccess'];
type Outgoing = Overview['outgoing'][number];
type Incoming = Overview['incoming'][number];
type Item = { name: string; present: boolean };

const STATUS_KEYS: Record<
  Exclude<Outgoing['targetStatus'], 'ready'>,
  PlainTranslationKey
> = {
  missing: 'ops.appAccess.status.missing',
  archived: 'ops.appAccess.status.archived',
  undeployed: 'ops.appAccess.status.undeployed',
};

/** One kind of grant (RPC, Data, tasks, webhook) and its items. */
function GrantRow({
  label,
  items,
}: {
  label: PlainTranslationKey;
  items: Item[];
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <Group gap="md" wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
        {t(label)}
      </Text>
      <Group gap={6}>
        {items.map((item) => (
          <Badge
            key={item.name}
            variant={!item.present ? 'outline' : 'light'}
            color={!item.present ? 'gray' : 'primary'}
            radius="sm"
            tt="none"
            ff="monospace"
            fw={500}
            title={!item.present ? t('ops.appAccess.itemMissing') : undefined}
            style={
              !item.present ? { textDecoration: 'line-through' } : undefined
            }
          >
            {item.name}
          </Badge>
        ))}
      </Group>
    </Group>
  );
}

type GrantItems = {
  rpc: Item[];
  dataTables: { read: Item[]; write: Item[] };
  tasks: Item[];
  webhook: Item[];
};

function Grants({ grant }: { grant: GrantItems }) {
  return (
    <Stack gap={4}>
      <GrantRow label="ops.appAccess.kind.rpc" items={grant.rpc} />
      <GrantRow
        label="ops.appAccess.kind.dataRead"
        items={grant.dataTables.read}
      />
      <GrantRow
        label="ops.appAccess.kind.dataWrite"
        items={grant.dataTables.write}
      />
      <GrantRow label="ops.appAccess.kind.tasks" items={grant.tasks} />
      <GrantRow label="ops.appAccess.kind.webhook" items={grant.webhook} />
    </Stack>
  );
}

function AppName({
  slug,
  name,
  appId,
}: {
  slug: string | null;
  name: string | null;
  appId: string;
}) {
  if (!slug) {
    return (
      <Text size="sm" fw={600} ff="monospace">
        {appId}
      </Text>
    );
  }
  return (
    <Anchor
      size="sm"
      fw={600}
      renderRoot={(props) => (
        <Link to="/app/$appSlug/manage" params={{ appSlug: slug }} {...props} />
      )}
    >
      {name ?? slug}
    </Anchor>
  );
}

function OutgoingEntry({ entry }: { entry: Outgoing }) {
  const { t } = useI18n();
  return (
    <Stack gap={4}>
      <Group gap={8} wrap="nowrap">
        <AppName slug={entry.slug} name={entry.name} appId={entry.appId} />
        {entry.alias ? (
          <Text size="xs" c="dimmed" ff="monospace">
            {t('ops.appAccess.alias', { alias: entry.alias })}
          </Text>
        ) : null}
        {entry.targetStatus === 'ready' ? null : (
          <Badge color="orange" variant="light" size="sm">
            {t(STATUS_KEYS[entry.targetStatus])}
          </Badge>
        )}
      </Group>
      <Grants grant={entry} />
    </Stack>
  );
}

function IncomingEntry({ entry }: { entry: Incoming }) {
  const { t } = useI18n();
  return (
    <Stack gap={4}>
      <Group gap={8} wrap="nowrap">
        <AppName slug={entry.slug} name={entry.name} appId={entry.appId} />
        {entry.alias ? (
          <Text size="xs" c="dimmed" ff="monospace">
            {t('ops.appAccess.alias', { alias: entry.alias })}
          </Text>
        ) : null}
      </Group>
      <Grants grant={entry} />
    </Stack>
  );
}

/**
 * Other Apps this one reaches through the platform (its manifest's
 * `appAccess`) and Apps that reach it, from the live deployments.
 */
export function AppAccessSection({ access }: { access: Overview }) {
  const { t } = useI18n();
  return (
    <Stack gap="sm">
      <SectionHeader
        icon={<IconPlugConnected size={16} stroke={1.8} />}
        title={t('ops.appAccess.title')}
      />
      <Text size="xs" c="dimmed">
        {t('ops.appAccess.body')}
      </Text>
      {access.outgoing.length > 0 ? (
        <Stack gap={8}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">
            {t('ops.appAccess.outgoing')}
          </Text>
          {access.outgoing.map((entry) => (
            <OutgoingEntry key={entry.appId} entry={entry} />
          ))}
        </Stack>
      ) : null}
      {access.incoming.length > 0 ? (
        <Stack gap={8}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">
            {t('ops.appAccess.incoming')}
          </Text>
          {access.incoming.map((entry) => (
            <IncomingEntry key={entry.appId} entry={entry} />
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}
