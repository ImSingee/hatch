import {
  ActionIcon,
  Alert,
  Code,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import { useI18n, type PlainTranslationKey } from '~i18n';

/** The values these components show, each with its whole-sentence copy. */
const VALUE_TEXT = {
  channelToken: {
    label: 'notifications.value.channelToken',
    copy: 'notifications.value.channelToken.copy',
    notice: 'notifications.value.channelToken.notice',
  },
  signingSecret: {
    label: 'notifications.value.signingSecret',
    copy: 'notifications.value.signingSecret.copy',
    notice: 'notifications.value.signingSecret.notice',
  },
  pushUrl: {
    label: 'notifications.value.pushUrl',
    copy: 'notifications.value.pushUrl.copy',
  },
  example: {
    label: 'notifications.value.example',
    copy: 'notifications.value.example.copy',
  },
} satisfies Record<
  string,
  {
    label: PlainTranslationKey;
    copy: PlainTranslationKey;
    notice?: PlainTranslationKey;
  }
>;

type ValueKind = keyof typeof VALUE_TEXT;
type SecretKind = {
  [Kind in ValueKind]: (typeof VALUE_TEXT)[Kind] extends { notice: string }
    ? Kind
    : never;
}[ValueKind];

/** A copyable value, e.g. a URL or command. */
export function CopyableCode({
  kind,
  value,
}: {
  kind: ValueKind;
  value: string;
}) {
  const { t } = useI18n();
  const text = VALUE_TEXT[kind];
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {t(text.label)}
      </Text>
      <Group gap={8} wrap="nowrap" align="flex-start">
        <Code
          block
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 'var(--mantine-font-size-xs)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {value}
        </Code>
        <Tooltip label={t('common.copy')} withArrow position="left">
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={t(text.copy)}
            onClick={() => {
              copy(value, { format: 'text/plain' });
              toast.success(t('common.copied'));
            }}
          >
            <IconCopy size={16} stroke={1.6} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Stack>
  );
}

/** A credential that is shown exactly once, with a reminder to store it. */
export function SecretReveal({
  kind,
  secret,
}: {
  kind: SecretKind;
  secret: string;
}) {
  const { t } = useI18n();
  return (
    <Stack gap="sm">
      <Alert
        color="yellow"
        variant="light"
        icon={<IconAlertTriangle size={18} stroke={1.6} />}
      >
        {t(VALUE_TEXT[kind].notice)}
      </Alert>
      <CopyableCode kind={kind} value={secret} />
    </Stack>
  );
}
