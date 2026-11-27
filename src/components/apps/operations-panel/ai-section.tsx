import {
  Badge,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconSparkles } from '@tabler/icons-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '~i18n';
import { formatRelativeTime } from '~lib/format';
import { appAiQueryOptions, appAiUsageQueryOptions } from '~queries/app-ai';
import {
  setAppAiBudgetFn,
  setAppAiRoleModelFn,
  type AppAiRoleView,
  type AppAiView,
} from '~server/app-ai';
import { SectionHeader } from './section-header';

function useUsd() {
  const { locale } = useI18n();
  return (value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
    }).format(value);
}

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
  const options = role.kind === 'chat' ? view.models.chat : view.models.image;
  const save = useMutation({
    mutationFn: (model: string | null) =>
      setAppAiRoleModelFn({ data: { id: appId, role: role.name, model } }),
    onSuccess: (next) => {
      qc.setQueryData(appAiQueryOptions(appId).queryKey, next);
      toast.success(t('ops.ai.modelSaved', { role: role.name }));
    },
  });
  const defaultModel = options[0];
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
          placeholder={
            defaultModel
              ? t('ops.ai.defaultModel', { model: defaultModel.name })
              : t('ops.ai.noModel')
          }
          clearable
          disabled={save.isPending || (!options.length && !role.bound)}
          onChange={(value) => save.mutate(value)}
          comboboxProps={{ withinPortal: true }}
        />
        {role.unavailable ? (
          <Text size="xs" c="red" mt={4}>
            {t('ops.ai.unavailable')}
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

function BudgetRow({ appId, view }: { appId: string; view: AppAiView }) {
  const { t } = useI18n();
  const usd = useUsd();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<number | string>(view.budgetUsd ?? '');
  const save = useMutation({
    mutationFn: (budgetUsd: number | null) =>
      setAppAiBudgetFn({ data: { id: appId, budgetUsd } }),
    onSuccess: (next) => {
      qc.setQueryData(appAiQueryOptions(appId).queryKey, next);
      setDraft(next.budgetUsd ?? '');
      toast.success(
        next.budgetUsd === null
          ? t('ops.ai.budgetCleared')
          : t('ops.ai.budgetSaved', { amount: usd(next.budgetUsd) }),
      );
    },
  });
  // Only an empty input removes the cap. Mantine keeps an unfinished number
  // such as `10.` as a string; parse it, and refuse anything else.
  const text = typeof draft === 'string' ? draft.trim() : null;
  const parsed: number | null | undefined =
    typeof draft === 'number'
      ? draft
      : text === ''
        ? null
        : Number.isFinite(Number(text))
          ? Number(text)
          : undefined;
  const changed = parsed !== undefined && parsed !== view.budgetUsd;
  return (
    <Stack gap={4}>
      <Group gap="xs" align="flex-end" wrap="wrap">
        <NumberInput
          size="xs"
          label={t('ops.ai.budget')}
          placeholder={t('ops.ai.noBudget')}
          prefix="$"
          min={0}
          max={1_000_000}
          decimalScale={2}
          value={draft}
          onChange={setDraft}
          style={{ width: 160 }}
        />
        <Button
          size="xs"
          variant="default"
          disabled={!changed || save.isPending}
          loading={save.isPending}
          onClick={() => {
            if (parsed !== undefined) save.mutate(parsed);
          }}
        >
          {t('common.save')}
        </Button>
        {view.budgetUsd !== null ? (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            {t('ops.ai.removeBudget')}
          </Button>
        ) : null}
      </Group>
      <Text size="xs" c="dimmed">
        {t('ops.ai.budgetHint')}
      </Text>
    </Stack>
  );
}

function UsageTable({ appId }: { appId: string }) {
  const { t, locale } = useI18n();
  const usd = useUsd();
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
              <Table.Th ta="right">{t('ops.ai.column.cost')}</Table.Th>
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
                <Table.Td ta="right">
                  {row.unpricedCalls === row.calls
                    ? t('ops.ai.unpriced')
                    : usd(row.costUsd)}
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
                  <Table.Td ta="right">
                    {call.costUsd === null
                      ? t('ops.ai.unpriced')
                      : usd(call.costUsd)}
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

/** The App's AI roles, the model each uses, its budget and its calls. */
export function AiSection({ appId }: { appId: string }) {
  const { t } = useI18n();
  const usd = useUsd();
  const { data: view } = useQuery(appAiQueryOptions(appId));
  if (!view) return null;
  return (
    <Stack gap="sm">
      <SectionHeader
        icon={<IconSparkles size={16} stroke={1.8} />}
        title={t('ops.ai.title')}
        meta={
          <Text size="xs" c="dimmed">
            {view.budgetUsd === null
              ? t('ops.ai.spend', { amount: usd(view.monthSpendUsd) })
              : t('ops.ai.spendOfBudget', {
                  amount: usd(view.monthSpendUsd),
                  budget: usd(view.budgetUsd),
                })}
          </Text>
        }
      />
      <Text size="xs" c="dimmed">
        {t('ops.ai.description')}
      </Text>
      <Table withTableBorder verticalSpacing={6}>
        <Table.Tbody>
          {view.roles.map((role) => (
            <RoleRow key={role.name} appId={appId} role={role} view={view} />
          ))}
        </Table.Tbody>
      </Table>
      <BudgetRow key={view.budgetUsd ?? 'none'} appId={appId} view={view} />
      <UsageTable appId={appId} />
    </Stack>
  );
}
