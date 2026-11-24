import {
  Alert,
  Button,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import type { AgentMessageMode } from '~/db/schema';
import { type PlainTranslationKey, useErrorText, useI18n } from '~i18n';
import { agentPreferencesQueryOptions } from '~queries/agent-preferences';
import { updateAgentPreferenceSettings } from '~server/agent-preference-settings';

const MODE_DESCRIPTION: Record<AgentMessageMode, PlainTranslationKey> = {
  steer: 'settings.agentPreferences.steerDescription',
  queue: 'settings.agentPreferences.queueDescription',
};

export function AgentPreferencesPanel() {
  const session = authClient.useSession();
  if (session.isPending) return <Skeleton height={96} />;
  if (!session.data || session.error) return null;
  return (
    <AgentPreferences
      key={session.data.user.id}
      userId={session.data.user.id}
    />
  );
}

function AgentPreferences({ userId }: { userId: string }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const queryClient = useQueryClient();
  const options = agentPreferencesQueryOptions(userId);
  const settings = useQuery(options);
  const save = useMutation({
    mutationFn: (messageMode: AgentMessageMode) =>
      updateAgentPreferenceSettings({ data: { messageMode } }),
    meta: { errorToast: false },
    retry: false,
    networkMode: 'always',
    onSuccess: (saved) => {
      queryClient.setQueryData(options.queryKey, saved);
      toast.success(t('settings.agentPreferences.saved'));
    },
    onError: (error) =>
      toast.error(errorText(error, 'settings.agentPreferences.saveFailed')),
  });

  if (settings.error) {
    return (
      <Alert color="red" title={t('settings.agentPreferences.loadFailed')}>
        <Text size="sm">
          {errorText(
            settings.error,
            'settings.agentPreferences.loadFailedBody',
          )}
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
  const mode = save.isPending
    ? (save.variables ?? settings.data.messageMode)
    : settings.data.messageMode;

  return (
    <Stack gap="md">
      <Stack gap={2}>
        <Text fw={600} id="agent-message-mode-label">
          {t('settings.agentPreferences.title')}
        </Text>
        <Text size="sm" c="dimmed">
          {t('settings.agentPreferences.description')}
        </Text>
      </Stack>
      <SegmentedControl
        aria-labelledby="agent-message-mode-label"
        value={mode}
        disabled={save.isPending}
        onChange={(value) => save.mutate(value as AgentMessageMode)}
        data={[
          { value: 'steer', label: t('settings.agentPreferences.steer') },
          { value: 'queue', label: t('settings.agentPreferences.queue') },
        ]}
        w="fit-content"
      />
      <Text size="sm">{t(MODE_DESCRIPTION[mode])}</Text>
    </Stack>
  );
}
