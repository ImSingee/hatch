import { Badge } from '@mantine/core';
import type { AppStatus } from '~/db/schema';
import { useI18n, type PlainTranslationKey } from '~i18n';

const statusMeta: Record<
  AppStatus,
  { label: PlainTranslationKey; color: string }
> = {
  draft: { label: 'appStatus.draft', color: 'gray' },
  building: { label: 'appStatus.building', color: 'primary' },
  deployed: { label: 'appStatus.deployed', color: 'primary' },
  failed: { label: 'appStatus.failed', color: 'red' },
  archived: { label: 'appStatus.archived', color: 'gray' },
};

export function StatusBadge({ status }: { status: AppStatus }) {
  const { t } = useI18n();
  // "Live" is the expected healthy state, so we don't badge it — only surface
  // statuses that actually need attention (draft / building / failed / archived).
  if (status === 'deployed') return null;
  const meta = statusMeta[status] ?? statusMeta.draft;
  return (
    <Badge color={meta.color} variant="light" radius="sm">
      {t(meta.label)}
    </Badge>
  );
}
