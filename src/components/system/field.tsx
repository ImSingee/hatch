import { Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { useI18n } from '~i18n';

/** One metadata row: a fixed-width dimmed label with its value alongside — one
 * pair per line, no box chrome. */
export function Field({
  label,
  value,
  mono,
  copyValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  /** When set, the value becomes a button that copies this text to clipboard. */
  copyValue?: string;
}) {
  const { t } = useI18n();
  const valueText = (
    <Text size="sm" ff={mono ? 'monospace' : undefined} truncate>
      {value}
    </Text>
  );
  return (
    <Group gap="md" wrap="nowrap" align="baseline">
      <Text size="sm" c="dimmed" style={{ width: 96, flex: 'none' }}>
        {label}
      </Text>
      {copyValue ? (
        <Tooltip label={t('common.copy')} withArrow position="top">
          <UnstyledButton
            onClick={() => {
              copy(copyValue);
              toast.success(t('common.copied'));
            }}
            style={{ minWidth: 0, maxWidth: 'fit-content' }}
          >
            {valueText}
          </UnstyledButton>
        </Tooltip>
      ) : (
        valueText
      )}
    </Group>
  );
}
