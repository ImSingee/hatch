import { ActionIcon, Code, Group, Tooltip } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { useI18n } from '~i18n';

/** A `hatch` command shown inline with a copy button. */
export function CliCommand({ command }: { command: string }) {
  const { t } = useI18n();
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Code style={{ fontSize: 'var(--mantine-font-size-xs)' }}>{command}</Code>
      <Tooltip label={t('appDocs.copyCommand')} withArrow position="top">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={t('appDocs.copyCommand')}
          onClick={() => {
            copy(command);
            toast.success(t('appDocs.commandCopied'));
          }}
        >
          <IconCopy size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}
