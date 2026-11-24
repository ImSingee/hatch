import { Group, SegmentedControl, Stack, Text } from '@mantine/core';
import {
  LANGUAGE_NAMES,
  LOCALES,
  changeLocale,
  isLocale,
  useI18n,
} from '~i18n';

/** This browser's interface language; switching keeps the page as it is. */
export function LanguagePanel() {
  const { t, locale } = useI18n();

  return (
    <Group justify="space-between" gap="md">
      <Stack gap={2}>
        <Text fw={700} id="language-label">
          {t('appearance.language.title')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('appearance.language.description')}
        </Text>
      </Stack>
      <SegmentedControl
        aria-labelledby="language-label"
        value={locale}
        data={LOCALES.map((value) => ({
          value,
          label: <span lang={value}>{LANGUAGE_NAMES[value]}</span>,
        }))}
        onChange={(value) => {
          if (isLocale(value)) void changeLocale(value);
        }}
      />
    </Group>
  );
}
