import {
  Alert,
  Button,
  Group,
  NumberInput,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  MAX_BACKGROUND_APP_MINUTES,
  MIN_BACKGROUND_APP_MINUTES,
  isBackgroundAppMinutes,
} from '~/desk-preferences';
import { useErrorText, useI18n } from '~i18n';
import { deskPreferencesQueryOptions } from '~queries/desk-preferences';
import { updateDeskPreferenceSettings } from '~server/desk-preference-settings';

/** How long a minimised App keeps running on the Desk, for this user. */
export function BackgroundAppsPanel() {
  const { t } = useI18n();
  const errorText = useErrorText();
  const settings = useQuery(deskPreferencesQueryOptions);

  if (settings.error) {
    return (
      <Alert color="red" title={t('settings.backgroundApps.loadFailed')}>
        <Text size="sm">
          {errorText(settings.error, 'settings.backgroundApps.loadFailedBody')}
        </Text>
        <Button
          type="button"
          variant="subtle"
          onClick={() => void settings.refetch()}
        >
          {t('common.tryAgain')}
        </Button>
      </Alert>
    );
  }
  if (!settings.data) return <Skeleton height={96} />;
  // Keyed by the saved value, so the field starts from it after each save.
  return (
    <BackgroundAppsForm
      key={settings.data.backgroundAppMinutes}
      saved={settings.data.backgroundAppMinutes}
    />
  );
}

function BackgroundAppsForm({ saved }: { saved: number }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState<number | string>(saved);
  const valid = isBackgroundAppMinutes(minutes);
  const save = useMutation({
    mutationFn: (backgroundAppMinutes: number) =>
      updateDeskPreferenceSettings({ data: { backgroundAppMinutes } }),
    meta: { errorToast: false },
    retry: false,
    networkMode: 'always',
    onSuccess: (next) => {
      queryClient.setQueryData(deskPreferencesQueryOptions.queryKey, next);
      toast.success(t('settings.backgroundApps.saved'));
    },
    onError: (error) =>
      toast.error(errorText(error, 'settings.backgroundApps.saveFailed')),
  });

  return (
    <Stack gap="md">
      <Stack gap={2}>
        <Text fw={600} id="background-apps-label">
          {t('settings.backgroundApps.title')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('settings.backgroundApps.description')}
        </Text>
      </Stack>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && minutes !== saved) save.mutate(minutes);
        }}
      >
        <Group gap="sm" align="flex-start">
          <NumberInput
            aria-labelledby="background-apps-label"
            value={minutes}
            onChange={setMinutes}
            min={MIN_BACKGROUND_APP_MINUTES}
            max={MAX_BACKGROUND_APP_MINUTES}
            allowDecimal={false}
            allowNegative={false}
            clampBehavior="none"
            suffix={t('settings.backgroundApps.unit')}
            error={
              valid || minutes === ''
                ? undefined
                : t('settings.backgroundApps.range', {
                    min: MIN_BACKGROUND_APP_MINUTES,
                    max: MAX_BACKGROUND_APP_MINUTES,
                  })
            }
            w={160}
          />
          <Button
            type="submit"
            variant="default"
            loading={save.isPending}
            disabled={!valid || minutes === saved}
          >
            {t('common.save')}
          </Button>
        </Group>
      </form>
    </Stack>
  );
}
