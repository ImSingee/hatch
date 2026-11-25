import {
  ActionIcon,
  Badge,
  Code,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCopy, IconWebhook } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { useI18n } from '~i18n';
import type { AppOps } from '~server/apps';
import { SectionHeader } from './section-header';

/** Inbound webhook URL (with platform-auth secret when applicable). */
export function WebhookSection({ webhook }: { webhook: AppOps['webhook'] }) {
  const { t } = useI18n();
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Stack gap={6}>
      <SectionHeader
        icon={<IconWebhook size={16} stroke={1.8} />}
        title={t('ops.webhook.title')}
        meta={
          <Badge
            size="xs"
            variant="light"
            color={webhook.auth === 'platform' ? 'teal' : 'gray'}
          >
            {webhook.auth === 'platform'
              ? t('ops.webhook.platformAuth')
              : t('ops.webhook.noPlatformAuth')}
          </Badge>
        }
      />
      <Group gap={8} wrap="nowrap" align="center">
        <Code
          block
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--mantine-font-size-xs)',
          }}
        >
          {webhook.auth === 'platform'
            ? `${webhook.url ?? ''}?secret=${webhook.secret ?? ''}`
            : (webhook.url ?? '')}
        </Code>
        <Tooltip
          label={
            webhook.auth === 'platform'
              ? t('ops.webhook.copyWithSecret')
              : t('ops.webhook.copy')
          }
          withArrow
          position="left"
        >
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t('ops.webhook.copyLabel')}
            onClick={() => {
              const url =
                webhook.auth === 'platform'
                  ? `${origin}${webhook.url ?? ''}?secret=${
                      webhook.secret ?? ''
                    }`
                  : `${origin}${webhook.url ?? ''}`;
              copy(url);
              toast.success(t('ops.webhook.copied'));
            }}
          >
            <IconCopy size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Text size="xs" c="dimmed">
        <Trans
          t={t}
          i18nKey={
            webhook.auth === 'platform'
              ? 'ops.webhook.platformNote'
              : 'ops.webhook.passthroughNote'
          }
          components={{ code: <Code /> }}
        />
      </Text>
    </Stack>
  );
}
