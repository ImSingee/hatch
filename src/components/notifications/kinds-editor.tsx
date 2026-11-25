import {
  ActionIcon,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useI18n } from '~i18n';

export type KindDraft = { kind: string; name: string; description: string };

export const EMPTY_KIND: KindDraft = { kind: '', name: '', description: '' };

export const KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type KindsProblem =
  | { type: 'none' }
  | { type: 'emptyId' }
  | { type: 'invalidId' | 'noName' | 'duplicate'; kind: string };

/** First problem with a kind list, or null when it can be saved. */
export function kindsError(kinds: KindDraft[]): KindsProblem | null {
  if (kinds.length === 0) return { type: 'none' };
  const seen = new Set<string>();
  for (const entry of kinds) {
    if (!KIND_PATTERN.test(entry.kind)) {
      return entry.kind
        ? { type: 'invalidId', kind: entry.kind }
        : { type: 'emptyId' };
    }
    if (!entry.name.trim()) return { type: 'noName', kind: entry.kind };
    if (seen.has(entry.kind)) return { type: 'duplicate', kind: entry.kind };
    seen.add(entry.kind);
  }
  return null;
}

/** The sentence for a kind list problem. */
export function KindsProblemText({ problem }: { problem: KindsProblem }) {
  const { t } = useI18n();
  switch (problem.type) {
    case 'none':
      return t('notifications.kinds.error.none');
    case 'emptyId':
      return t('notifications.kinds.error.emptyId');
    case 'invalidId':
      return t('notifications.kinds.error.invalidId', { kind: problem.kind });
    case 'noName':
      return t('notifications.kinds.error.noName', { kind: problem.kind });
    case 'duplicate':
      return t('notifications.kinds.error.duplicate', { kind: problem.kind });
  }
}

export function toKindInput(kinds: KindDraft[]) {
  return kinds.map((entry) => ({
    kind: entry.kind.trim(),
    name: entry.name.trim(),
    ...(entry.description.trim()
      ? { description: entry.description.trim() }
      : {}),
  }));
}

/** Edit the notification kinds a Channel declares. */
export function KindsEditor({
  value,
  onChange,
}: {
  value: KindDraft[];
  onChange: (value: KindDraft[]) => void;
}) {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<KindDraft>) =>
    onChange(
      value.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {t('notifications.kinds.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('notifications.kinds.description')}
      </Text>
      {value.map((entry, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            placeholder="deploy.failed"
            aria-label={t('notifications.kinds.id')}
            value={entry.kind}
            onChange={(event) =>
              update(index, { kind: event.currentTarget.value.toLowerCase() })
            }
            ff="monospace"
            style={{ flex: 1 }}
          />
          <TextInput
            placeholder={t('notifications.kinds.namePlaceholder')}
            aria-label={t('notifications.kinds.name')}
            value={entry.name}
            onChange={(event) =>
              update(index, { name: event.currentTarget.value })
            }
            style={{ flex: 1 }}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            mt={6}
            aria-label={t('notifications.kinds.remove')}
            disabled={value.length === 1}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            <IconTrash size={16} stroke={1.6} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        variant="subtle"
        size="xs"
        leftSection={<IconPlus size={14} stroke={1.8} />}
        onClick={() => onChange([...value, EMPTY_KIND])}
        w="fit-content"
      >
        {t('notifications.kinds.add')}
      </Button>
    </Stack>
  );
}
