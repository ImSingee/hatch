import {
  Alert,
  Button,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useSuspenseQuery } from '@tanstack/react-query';
import copy from 'copy-to-clipboard';
import { Trans } from 'react-i18next';
import { toast } from 'sonner';
import { buildInfo } from '~/build-info';
import { useI18n } from '~i18n';
import { serverInfoQueryOptions } from '~queries/server-info';

export function AboutPanel() {
  const { t } = useI18n();
  const { data: server } = useSuspenseQuery(serverInfoQueryOptions);
  const { commit, commitTime } = server;
  // This page's code was bundled from `buildInfo`; the server may have been
  // redeployed since the page loaded.
  const outdated =
    commit !== null && buildInfo.commit !== null && buildInfo.commit !== commit;
  return (
    <Stack gap="xl">
      {outdated && (
        <Alert color="yellow" title={t('settings.about.outdatedTitle')}>
          <Stack gap="sm" align="flex-start">
            <Text size="sm">
              <Trans
                t={t}
                i18nKey="settings.about.outdatedBody"
                values={{ commit: buildInfo.commit?.slice(0, 12) ?? '' }}
                components={{ commit: <Text span ff="monospace" fz="sm" /> }}
              />
            </Text>
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={() => window.location.reload()}
            >
              {t('settings.about.reload')}
            </Button>
          </Stack>
        </Alert>
      )}
      <Stack gap="xs">
        <Text size="sm" fw={700}>
          {t('settings.about.commit')}
        </Text>
        {commit ? (
          <Tooltip label={t('settings.about.copyCommit')} withArrow>
            <UnstyledButton
              type="button"
              aria-label={t('settings.about.copyCommitName', { commit })}
              ff="monospace"
              fz="sm"
              w="fit-content"
              maw="100%"
              style={{ overflowWrap: 'anywhere' }}
              onClick={async () => {
                if (await copy(commit).catch(() => false))
                  toast.success(t('settings.about.commitCopied'));
                else toast.error(t('settings.about.copyFailed'));
              }}
            >
              {commit}
            </UnstyledButton>
          </Tooltip>
        ) : (
          <Text size="sm" ff="monospace">
            {t('common.unknown')}
          </Text>
        )}
      </Stack>
      <Stack gap="xs">
        <Text size="sm" fw={700}>
          {t('settings.about.commitTime')}
        </Text>
        <Text size="sm">
          {commitTime ? (
            <time dateTime={commitTime}>{commitTime}</time>
          ) : (
            t('common.unknown')
          )}
        </Text>
      </Stack>
    </Stack>
  );
}
