import { Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authClient, currentUserId } from '~auth/client';
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
  const saved = useQuery({
    ...interfacePreferencesQueryOptions(userId ?? ''),
    enabled: !!userId,
  }).data;
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
      return { previous, userId };
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
    // so say that, once the language is back, instead of the raw request
    // error. "Back" is the account's language when it has one, which may
    // have been saved elsewhere while this request was in flight; only
    // without one does the language from before the click return. When
    // another account signed in meanwhile, its language is on screen and
    // this failure is not its business.
    onError: async (_error, _language, context) => {
      if (!context?.userId || currentUserId() !== context.userId) return;
      const account = userId
        ? queryClient.getQueryData(
            interfacePreferencesQueryOptions(userId).queryKey,
          )?.language
        : null;
      const restore = account ?? context?.previous;
      if (restore) await changeLocale(restore);
      toast.error(i18n.t('appearance.language.saveFailed'));
    },
  });

  // Until the account has a language, nothing is selected: the one on screen
  // only comes from this browser, and picking it is how it gets saved.
  const unsaved = saved !== undefined && saved.language === null;
  const value = save.isPending
    ? save.variables
    : unsaved
      ? null
      : (saved?.language ?? locale);

  return (
    <Group justify="space-between" gap="md">
      <Stack gap={2}>
        <Text fw={700} id="language-label">
          {t('appearance.language.title')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('appearance.language.description')}
        </Text>
        {unsaved && !save.isPending ? (
          <Text size="sm" c="dimmed">
            {t('appearance.language.notSaved')}
          </Text>
        ) : null}
      </Stack>
      <SegmentedControl
        aria-labelledby="language-label"
        value={value ?? ''}
        disabled={save.isPending}
        data={LOCALES.map((value) => ({
          value,
          label: <span lang={value}>{LANGUAGE_NAMES[value]}</span>,
        }))}
        onChange={(value) => {
          if (isLocale(value)) save.mutate(value);
        }}
      />
    </Group>
  );
}
