import { createFileRoute } from '@tanstack/react-router';
import { IconBell } from '@tabler/icons-react';
import { EmptyState, WindowBody } from '~components/page/page';
import { useI18n } from '~i18n';

export const Route = createFileRoute('/_app/notifications/log/')({
  component: NoNotificationOpen,
});

/** The right half before a notification is picked. */
function NoNotificationOpen() {
  const { t } = useI18n();
  return (
    <WindowBody tone="sheet">
      <EmptyState
        icon={<IconBell size={26} stroke={1.6} />}
        title={t('notifications.window.pickTitle')}
      >
        {t('notifications.window.pickBody')}
      </EmptyState>
    </WindowBody>
  );
}
