import { Badge } from '@mantine/core';
import type { AppStatus } from '~/db/schema';

const statusMeta: Record<AppStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'gray' },
  building: { label: 'Building', color: 'primary' },
  deployed: { label: 'Live', color: 'primary' },
  failed: { label: 'Failed', color: 'red' },
  archived: { label: 'Archived', color: 'gray' },
};

export function StatusBadge({ status }: { status: AppStatus }) {
  // "Live" is the expected healthy state, so we don't badge it — only surface
  // statuses that actually need attention (draft / building / failed / archived).
  if (status === 'deployed') return null;
  const meta = statusMeta[status] ?? statusMeta.draft;
  return (
    <Badge color={meta.color} variant="light" radius="sm">
      {meta.label}
    </Badge>
  );
}
