import { Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import {
  LANGUAGE_NAMES,
  LOCALES,
  changeLocale,
  i18n,
  isLocale,
  useI18n,
  type Locale,
} from '~i18n';
import { interfacePreferencesQueryOptions } from '~queries/interface-preferences';
import { updateInterfacePreferenceSettings } from '~server/interface-preference-settings';

/**
 * The signed-in user's interface language. Switching applies at once, keeps
 * the page as it is, and is saved to the account for every browser.
 */
export function LanguagePanel() {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const userId = authClient.useSession().data?.user.id;
  const save = useMutation({
    mutationFn: (language: Locale) =>
      updateInterfacePreferenceSettings({ data: { language } }),
    meta: { errorToast: false },
    retry: false,
    networkMode: 'always',
    onMutate: async (language) => {
      const previous = locale;
      if (userId) {
        // A refresh still in flight must not switch back to the old value.
        await queryClient.cancelQueries({
          queryKey: interfacePreferencesQueryOptions(userId).queryKey,
        });
      }
      await changeLocale(language);
      return { previous };
    },
    onSuccess: (saved) => {
      if (saved.userId === userId) {
        queryClient.setQueryData(
          interfacePreferencesQueryOptions(saved.userId).queryKey,
          saved,
        );
      }
    },
    // The only thing a reader can act on is that the switch did not stick,
    // so say that, once the previous language is back, instead of the raw
    // request error.
    onError: async (_error, _language, context) => {
      if (context) await changeLocale(context.previous);
      toast.error(i18n.t('appearance.language.saveFailed'));
    },
  });

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
        value={save.isPending ? (save.variables ?? locale) : locale}
        disabled={save.isPending}
        data={LOCALES.map((value) => ({
          value,
          label: <span lang={value}>{LANGUAGE_NAMES[value]}</span>,
        }))}
        onChange={(value) => {
          if (isLocale(value) && value !== locale) save.mutate(value);
        }}
      />
    </Group>
  );
}
