import { Center, Loader, Table, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { useI18n } from '~i18n';
import { formatDuration, formatRelativeTime } from '~lib/format';
import type { RunListItem } from '~lib/runs';
import {
  EmptyLine,
  GroupCard,
  Section,
  TableCard,
} from '~components/page/page';
import { RunStatusBadge, RunTriggerLabel } from './run-status';

export type RunTableColumn<T> = {
  /** Stable React key; the header is translated copy. */
  key: string;
  header: string;
  cell: (run: T) => ReactNode;
};

/**
 * The App task run history table. The caller
 * owns data fetching and navigation: `renderLink` wraps the status badge in
 * a real link (open in new tab, keyboard) and `onOpen` handles a row click.
 */
export function RunTable<T extends RunListItem>({
  title,
  runs,
  total,
  loading,
  emptyText,
  aside,
  footer,
  leadColumns = [],
  renderLink,
  onOpen,
}: {
  title: string;
  runs: T[];
  /** Count shown beside the title; defaults to the rows shown. */
  total?: number;
  loading: boolean;
  emptyText: string;
  aside?: ReactNode;
  footer?: ReactNode;
  /** Extra columns shown before the status column. */
  leadColumns?: RunTableColumn<T>[];
  renderLink: (run: T, children: ReactNode) => ReactNode;
  onOpen: (run: T) => void;
}) {
  const { t, locale } = useI18n();
  const count = total ?? runs.length;
  return (
    <Section
      title={title}
      meta={count > 0 ? String(count) : undefined}
      aside={aside}
    >
      {loading ? (
        <GroupCard>
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        </GroupCard>
      ) : runs.length === 0 ? (
        <GroupCard>
          <EmptyLine>{emptyText}</EmptyLine>
        </GroupCard>
      ) : (
        <TableCard>
          <Table.Thead>
            <Table.Tr>
              {leadColumns.map((column) => (
                <Table.Th key={column.key}>{column.header}</Table.Th>
              ))}
              <Table.Th>{t('executions.column.status')}</Table.Th>
              <Table.Th>{t('executions.column.trigger')}</Table.Th>
              <Table.Th>{t('executions.column.steps')}</Table.Th>
              <Table.Th>{t('executions.column.duration')}</Table.Th>
              <Table.Th>{t('executions.column.started')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {runs.map((run) => (
              <Table.Tr
                key={run.id}
                style={{ cursor: 'pointer' }}
                onClick={() => onOpen(run)}
              >
                {leadColumns.map((column) => (
                  <Table.Td key={column.key}>{column.cell(run)}</Table.Td>
                ))}
                <Table.Td>
                  {renderLink(run, <RunStatusBadge status={run.status} />)}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    <RunTriggerLabel trigger={run.trigger} />
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {run.stepCount}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {formatDuration(run.durationMs)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {formatRelativeTime(run.startedAt ?? run.createdAt, locale)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </TableCard>
      )}
      {footer}
    </Section>
  );
}
