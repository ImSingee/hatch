import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Code,
  Collapse,
  Group,
  JsonInput,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconTable,
  IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { useErrorText, useI18n, type PlainTranslationKey } from '~i18n';
import { CodedError } from '~lib/error-codes';
import { formatRelativeTime } from '~lib/format';
import { appDataTablesQueryOptions } from '~queries/apps';
import { mutateAppDataTableFn, queryAppDataTableFn } from '~server/apps';
import { SectionHeader } from './section-header';

type Row = Record<string, unknown> & { id?: string };
type RowFields = Record<string, { optional: boolean }>;
type RowPatch = { value: Record<string, unknown>; unset: string[] };
type TableViewState = {
  table: string | null;
  cursor: string | null;
  history: string[];
};

/** A row value the form rejects before saving, shown with its own fallback. */
class RowInputError extends Error {
  readonly reason: unknown;
  readonly fallback: PlainTranslationKey;

  constructor(reason: unknown, fallback: PlainTranslationKey) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'RowInputError';
    this.reason = reason;
    this.fallback = fallback;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function changedRowFields(
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
  fields: RowFields,
): RowPatch {
  const value = Object.fromEntries(
    Object.entries(edited).filter(
      ([key, value]) =>
        !Object.hasOwn(original, key) || !jsonValuesEqual(original[key], value),
    ),
  );
  const unset = Object.keys(original).filter(
    (key) => !Object.hasOwn(edited, key),
  );
  for (const key of unset) {
    const field = fields[key];
    if (!field) {
      throw new CodedError(
        `Field "${key}" is no longer in the Data Table schema. Reload and retry.`,
        'ops.dataTable.fieldRemoved',
        { name: key },
      );
    }
    if (!field.optional) {
      throw new CodedError(
        `Required field "${key}" cannot be removed.`,
        'ops.dataTable.requiredRemoved',
        { name: key },
      );
    }
  }
  return { value, unset };
}

function QueryFailure({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Text size="xs" c="red">
        {errorText(error, 'ops.dataTable.loadFailed')}
      </Text>
      <Button
        type="button"
        size="compact-xs"
        variant="light"
        color="red"
        loading={retrying}
        onClick={onRetry}
      >
        {t('common.retry')}
      </Button>
    </Group>
  );
}

function RowForm({
  appId,
  table,
  fields,
  row,
}: {
  appId: string;
  table: string;
  fields: RowFields;
  row?: Row;
}) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const errorText = useErrorText();
  const editable = row
    ? Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['id', 'createdAt', 'updatedAt'].includes(key),
        ),
      )
    : {};
  const [value, setValue] = useState(JSON.stringify(editable, null, 2));
  const [error, setError] = useState<{
    cause: unknown;
    fallback: PlainTranslationKey;
  } | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(value) as Record<string, unknown>;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw new CodedError(
            'Row value must be a JSON object.',
            'ops.dataTable.rowNotObject',
          );
        }
      } catch (cause) {
        throw new RowInputError(cause, 'ops.dataTable.invalidJson');
      }
      let operation:
        | {
            type: 'patch';
            table: string;
            id: string;
            value: Record<string, unknown>;
            unset?: string[];
          }
        | {
            type: 'insert';
            table: string;
            value: Record<string, unknown>;
          };
      try {
        if (!row?.id) {
          operation = { type: 'insert', table, value: parsed };
        } else {
          const patch = changedRowFields(editable, parsed, fields);
          if (
            Object.keys(patch.value).length === 0 &&
            patch.unset.length === 0
          ) {
            throw new CodedError(
              'No changes to save.',
              'ops.dataTable.noChanges',
            );
          }
          operation = {
            type: 'patch',
            table,
            id: row.id,
            value: patch.value,
            ...(patch.unset.length > 0 ? { unset: patch.unset } : {}),
          };
        }
      } catch (cause) {
        throw new RowInputError(cause, 'ops.dataTable.invalidRow');
      }
      return mutateAppDataTableFn({
        data: {
          id: appId,
          mutation: { operations: [operation] },
        },
      });
    },
    onSuccess: () => {
      toast.success(
        row ? t('ops.dataTable.rowUpdated') : t('ops.dataTable.rowAdded'),
      );
      void qc.invalidateQueries({
        queryKey: ['apps', appId, 'data-table-rows'],
      });
      void qc.invalidateQueries(appDataTablesQueryOptions(appId));
      modals.closeAll();
    },
    onError: (cause) => {
      setError(
        cause instanceof RowInputError
          ? { cause: cause.reason, fallback: cause.fallback }
          : { cause, fallback: 'ops.dataTable.saveFailed' },
      );
    },
    // Every failure is shown inline on the row value.
    meta: { errorToast: false },
  });

  return (
    <Stack gap="sm">
      <JsonInput
        label={t('ops.dataTable.rowValue')}
        description={t('ops.dataTable.rowValueDescription')}
        value={value}
        onChange={(next) => {
          setValue(next);
          setError(null);
        }}
        error={error ? errorText(error.cause, error.fallback) : null}
        validationError={t('ops.dataTable.invalidJson')}
        formatOnBlur
        autosize
        minRows={8}
        maxRows={18}
        data-autofocus
      />
      <Group justify="flex-end">
        <Button
          type="button"
          variant="default"
          onClick={() => modals.closeAll()}
        >
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {row ? t('common.save') : t('common.add')}
        </Button>
      </Group>
    </Stack>
  );
}

export function DataTableSection({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const { t, locale } = useI18n();
  const errorText = useErrorText();
  const info = useQuery(appDataTablesQueryOptions(appId));
  const tables = useMemo(() => info.data?.tables ?? [], [info.data?.tables]);
  const [tableState, setTableState] = useState<TableViewState>({
    table: null,
    cursor: null,
    history: [],
  });
  const nextTable = tables.some((item) => item.name === tableState.table)
    ? tableState.table
    : (tables[0]?.name ?? null);
  let currentTableState = tableState;
  if (nextTable !== tableState.table) {
    currentTableState = { table: nextTable, cursor: null, history: [] };
    setTableState(currentTableState);
  }
  const { table, cursor, history: cursorHistory } = currentTableState;
  const [showMigrations, setShowMigrations] = useState(false);

  const rows = useQuery({
    queryKey: ['apps', appId, 'data-table-rows', table, cursor],
    queryFn: () =>
      queryAppDataTableFn({
        data: {
          id: appId,
          query: { table, cursor: cursor ?? undefined, limit: 50 },
        },
      }),
    enabled: Boolean(table),
  });

  const columns = useMemo(() => {
    if (!table || !info.data) return [];
    const descriptor = info.data.schema.tables[table];
    return ['id', ...Object.keys(descriptor?.fields ?? {}), 'updatedAt'];
  }, [info.data, table]);

  const remove = useMutation({
    mutationFn: (id: string) =>
      mutateAppDataTableFn({
        data: {
          id: appId,
          mutation: { operations: [{ type: 'delete', table, id }] },
        },
      }),
    onSuccess: () => {
      toast.success(t('ops.dataTable.rowDeleted'));
      void qc.invalidateQueries({
        queryKey: ['apps', appId, 'data-table-rows'],
      });
      void qc.invalidateQueries(appDataTablesQueryOptions(appId));
    },
    onError: (cause) => {
      toast.error(errorText(cause, 'ops.dataTable.deleteFailed'));
    },
    // The toast above reports the failure.
    meta: { errorToast: false },
  });

  const openEditor = (row?: Row) => {
    if (!table || !info.data) return;
    const descriptor = info.data.schema.tables[table];
    if (!descriptor) return;
    modals.open({
      title: row
        ? t('ops.dataTable.editRowTitle', { table })
        : t('ops.dataTable.addRowTitle', { table }),
      size: 'lg',
      children: (
        <RowForm
          appId={appId}
          table={table}
          fields={descriptor.fields}
          row={row}
        />
      ),
    });
  };

  const confirmDelete = (row: Row) => {
    if (!row.id) return;
    modals.openConfirmModal({
      title: t('ops.dataTable.deleteRowTitle'),
      children: (
        <Text size="sm">
          <Trans
            t={t}
            i18nKey="ops.dataTable.deleteRowBody"
            values={{ id: row.id, table: table ?? '' }}
            components={{ id: <Code />, table: <Code /> }}
          />
        </Text>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(row.id as string),
    });
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <SectionHeader
          icon={<IconTable size={16} stroke={1.8} />}
          title={t('ops.dataTable.title')}
          meta={
            info.data ? (
              <Text size="xs" c="dimmed" ff="monospace">
                {info.data.schemaHash.slice(0, 10)}
              </Text>
            ) : null
          }
        />
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={!table}
          onClick={() => openEditor()}
        >
          {t('ops.dataTable.addRow')}
        </Button>
      </Group>

      {info.isError ? (
        <QueryFailure
          error={info.error}
          retrying={info.isFetching}
          onRetry={() => void info.refetch()}
        />
      ) : null}

      {info.isLoading ? (
        <Center py="sm">
          <Loader size="sm" />
        </Center>
      ) : !info.data ? (
        info.isError ? null : (
          <Text size="xs" c="dimmed">
            {t('ops.dataTable.noSchema')}
          </Text>
        )
      ) : (
        <>
          <Group align="end">
            <Select
              label={t('ops.dataTable.table')}
              data={tables.map((item) => ({
                value: item.name,
                label: `${item.name} (~${item.rowCount})`,
              }))}
              value={table}
              onChange={(next) => {
                setTableState({ table: next, cursor: null, history: [] });
              }}
              allowDeselect={false}
              style={{ width: 260 }}
            />
            <Button
              type="button"
              variant="subtle"
              color="gray"
              rightSection={<IconChevronDown size={14} />}
              onClick={() => setShowMigrations((value) => !value)}
            >
              {t('ops.dataTable.migrations', {
                count: info.data.migrations.length,
              })}
            </Button>
          </Group>
          <Collapse expanded={showMigrations}>
            <Stack gap="xs">
              {info.data.migrations.map((migration) => (
                <Stack key={migration.id} gap={3}>
                  <Group gap="xs">
                    <Text size="xs" fw={700}>
                      #{migration.id}
                    </Text>
                    {migration.destructive ? (
                      <Badge size="xs" color="orange" variant="light">
                        {t('ops.dataTable.destructive')}
                      </Badge>
                    ) : null}
                    <Text size="xs" c="dimmed">
                      {formatRelativeTime(migration.appliedAt, locale)} ·{' '}
                      {migration.schemaHash.slice(0, 10)}
                    </Text>
                  </Group>
                  <Code block>
                    {migration.sql || t('ops.dataTable.schemaUnchanged')}
                  </Code>
                </Stack>
              ))}
            </Stack>
          </Collapse>

          {rows.isError ? (
            <QueryFailure
              error={rows.error}
              retrying={rows.isFetching}
              onRetry={() => void rows.refetch()}
            />
          ) : null}

          {rows.isLoading ? (
            <Center py="lg">
              <Loader size="sm" />
            </Center>
          ) : !rows.data ? null : rows.data.items.length === 0 ? (
            <Text size="xs" c="dimmed">
              {t('ops.dataTable.noRows')}
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={700}>
              <Table withTableBorder verticalSpacing={6} highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {columns.map((column) => (
                      <Table.Th key={column}>{column}</Table.Th>
                    ))}
                    <Table.Th w={72} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.data?.items.map((row) => (
                    <Table.Tr key={String(row.id)}>
                      {columns.map((column) => (
                        <Table.Td key={column} maw={240}>
                          <Text size="xs" ff="monospace" truncate>
                            {typeof row[column] === 'object'
                              ? JSON.stringify(row[column])
                              : String(row[column] ?? '')}
                          </Text>
                        </Table.Td>
                      ))}
                      <Table.Td>
                        <Group gap={2} wrap="nowrap">
                          <Tooltip label={t('common.edit')} withArrow>
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label={t('ops.dataTable.editRowLabel', {
                                id: String(row.id),
                              })}
                              onClick={() => openEditor(row)}
                            >
                              <IconPencil size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label={t('common.delete')} withArrow>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={t('ops.dataTable.deleteRowLabel', {
                                id: String(row.id),
                              })}
                              onClick={() => confirmDelete(row)}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {rows.data ? (
            <Group justify="flex-end">
              <ActionIcon
                variant="default"
                aria-label={t('ops.dataTable.previousPage')}
                disabled={cursorHistory.length === 0}
                onClick={() => {
                  const history = [...cursorHistory];
                  setTableState({
                    table,
                    cursor: history.pop() ?? null,
                    history,
                  });
                }}
              >
                <IconChevronLeft size={15} />
              </ActionIcon>
              <ActionIcon
                variant="default"
                aria-label={t('ops.dataTable.nextPage')}
                disabled={!rows.data.cursor}
                onClick={() => {
                  setTableState({
                    table,
                    cursor: rows.data.cursor,
                    history: [...cursorHistory, cursor ?? ''],
                  });
                }}
              >
                <IconChevronRight size={15} />
              </ActionIcon>
            </Group>
          ) : null}
        </>
      )}
    </Stack>
  );
}
