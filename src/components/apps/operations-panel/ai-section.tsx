import {
  Anchor,
  Badge,
  Group,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IconSparkles } from '@tabler/icons-react';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import { appAiQueryOptions, appAiUsageQueryOptions } from '~queries/app-ai';
import {
  setAppAiRoleModelFn,
  type AppAiRoleView,
  type AppAiView,
} from '~server/app-ai';
import { SectionHeader } from './section-header';

function RoleRow({
  appId,
  role,
  view,
}: {
  appId: string;
  role: AppAiRoleView;
  view: AppAiView;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const options = view.models[role.kind];
  const save = useMutation({
    mutationFn: (model: string | null) =>
      setAppAiRoleModelFn({ data: { id: appId, role: role.name, model } }),
    // Refetch instead of writing this response: saves of different roles can
    // finish out of order, and an older full view would undo the other pick.
    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: appAiQueryOptions(appId).queryKey,
        exact: true,
      });
      toast.success(t('ops.ai.modelSaved', { role: role.name }));
    },
  });
  const data = options.map((option) => ({
    value: option.id,
    label: `${option.name} · ${option.providerName}`,
  }));
  // A disabled pick is still shown so the owner sees what broke.
  if (role.bound && role.unavailable && role.model)
    data.push({
      value: role.model.id,
      label: `${role.model.name} · ${role.model.providerName}`,
    });
  // Unpicked: the placeholder names the model the role uses and where it
  // comes from.
  const placeholder = !role.model
    ? t('ops.ai.noModel')
    : role.defaultSource === 'setting'
      ? t('ops.ai.defaultModel', { model: role.model.name })
      : t('ops.ai.firstModel', { model: role.model.name });

  return (
    <Table.Tr>
      <Table.Td style={{ verticalAlign: 'top' }}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} ff="monospace">
            {role.name}
          </Text>
          <Badge size="xs" variant="light" color="gray" radius="sm">
            {role.kind === 'chat'
              ? t('ops.ai.kind.chat')
              : t('ops.ai.kind.image')}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {role.description}
        </Text>
      </Table.Td>
      <Table.Td style={{ verticalAlign: 'top', width: '50%' }}>
        <Select
          size="xs"
          aria-label={t('ops.ai.modelFor', { role: role.name })}
          data={data}
          value={role.bound ? (role.model?.id ?? null) : null}
          placeholder={placeholder}
          clearable
          disabled={save.isPending || (!options.length && !role.bound)}
          onChange={(value) => save.mutate(value)}
          comboboxProps={{ withinPortal: true }}
        />
        {role.unavailable ? (
          <Text size="xs" c="red" mt={4}>
            {role.bound
              ? t('ops.ai.unavailable')
              : t('ops.ai.defaultUnavailable')}
          </Text>
        ) : null}
        {role.missingNeeds.length ? (
          <Text size="xs" c="orange" mt={4}>
            {t('ops.ai.missingReasoning')}
          </Text>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}

function UsageTable({ appId }: { appId: string }) {
  const { t, locale } = useI18n();
  const { data } = useQuery(appAiUsageQueryOptions(appId));
  if (!data) return null;
  const number = new Intl.NumberFormat(locale);
  return (
    <Stack gap={6}>
      <Text size="xs" fw={600} c="dimmed">
        {t('ops.ai.thisMonth')}
      </Text>
      {data.totals.length ? (
        <Table withTableBorder verticalSpacing={4} fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('ops.ai.column.role')}</Table.Th>
              <Table.Th>{t('ops.ai.column.model')}</Table.Th>
              <Table.Th ta="right">{t('ops.ai.column.calls')}</Table.Th>
              <Table.Th ta="right">{t('ops.ai.column.tokens')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.totals.map((row) => (
              <Table.Tr key={`${row.role}:${row.providerName}:${row.modelId}`}>
                <Table.Td ff="monospace">{row.role}</Table.Td>
                <Table.Td>
                  {row.providerName} / {row.modelId}
                </Table.Td>
                <Table.Td ta="right">{number.format(row.calls)}</Table.Td>
                <Table.Td ta="right">
                  {row.images
                    ? t('ops.ai.images', { count: row.images })
                    : t('ops.ai.tokens', {
                        input: number.format(row.inputTokens),
                        output: number.format(row.outputTokens),
                      })}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="xs" c="dimmed">
          {t('ops.ai.noCalls')}
        </Text>
      )}
      {data.calls.length ? (
        <>
          <Text size="xs" fw={600} c="dimmed" mt={4}>
            {t('ops.ai.recentCalls')}
          </Text>
          <Table withTableBorder verticalSpacing={4} fz="xs">
            <Table.Tbody>
              {data.calls.map((call) => (
                <Table.Tr key={call.id}>
                  <Table.Td c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {formatRelativeTime(call.createdAt, locale)}
                  </Table.Td>
                  <Table.Td ff="monospace">{call.role}</Table.Td>
                  <Table.Td>{call.modelId}</Table.Td>
                  <Table.Td>
                    <Badge
                      size="xs"
                      variant="light"
                      radius="sm"
                      color={
                        call.status === 'ok'
                          ? 'green'
                          : call.status === 'aborted'
                            ? 'gray'
                            : 'red'
                      }
                    >
                      {call.status === 'ok'
                        ? t('ops.ai.status.ok')
                        : call.status === 'aborted'
                          ? t('ops.ai.status.aborted')
                          : t('ops.ai.status.error')}
                    </Badge>
                  </Table.Td>
                  <Table.Td ta="right" c="dimmed">
                    {call.images
                      ? t('ops.ai.images', { count: call.images })
                      : t('ops.ai.tokens', {
                          input: number.format(call.inputTokens),
                          output: number.format(call.outputTokens),
                        })}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      ) : null}
    </Stack>
  );
}

/** The App's AI roles, the model each uses, and its calls. */
export function AiSection({ appId }: { appId: string }) {
  const { t } = useI18n();
  const { data: view } = useQuery(appAiQueryOptions(appId));
  if (!view) return null;
  return (
    <Stack gap="sm">
      <SectionHeader
        icon={<IconSparkles size={16} stroke={1.8} />}
        title={t('ops.ai.title')}
        meta={
          <Text size="xs" c="dimmed">
            {t('ops.ai.roles', { count: view.roles.length })}
          </Text>
        }
      />
      <Text size="xs" c="dimmed">
        <Trans
          t={t}
          i18nKey="ops.ai.description"
          components={{
            link: (
              <Anchor component={Link} to="/settings/providers" size="xs" />
            ),
          }}
        />
      </Text>
      <Table withTableBorder verticalSpacing={6}>
        <Table.Tbody>
          {view.roles.map((role) => (
            <RoleRow key={role.name} appId={appId} role={role} view={view} />
          ))}
        </Table.Tbody>
      </Table>
      <UsageTable appId={appId} />
    </Stack>
  );
}
