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
import { agentPreferencesQueryOptions } from '~queries/agent-preferences';
import { updateAgentPreferenceSettings } from '~server/agent-preference-settings';

const MODE_DESCRIPTION: Record<AgentMessageMode, string> = {
  steer:
    'Your message joins the current reply as soon as the Agent finishes its running steps. Several waiting messages arrive together.',
  queue:
    'Your message waits until the current reply finishes, then is sent as its own message. Several waiting messages are sent one by one.',
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
      toast.success('Agent preference updated');
    },
    onError: (error) =>
      toast.error(error.message || 'Could not update the preference.'),
  });

  if (settings.error) {
    return (
      <Alert color="red" title="Agent preferences could not be loaded">
        <Text size="sm">{settings.error.message}</Text>
        <Button
          type="button"
          variant="subtle"
          onClick={() => void settings.refetch()}
        >
          Try again
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
          Messages sent while the Agent works
        </Text>
        <Text size="sm" c="dimmed">
          Choose what happens when you send a message before the Agent has
          finished replying. Waiting messages can still be edited, cancelled or
          sent right away.
        </Text>
      </Stack>
      <SegmentedControl
        aria-labelledby="agent-message-mode-label"
        value={mode}
        disabled={save.isPending}
        onChange={(value) => save.mutate(value as AgentMessageMode)}
        data={[
          { value: 'steer', label: 'Steer the current reply' },
          { value: 'queue', label: 'Queue as the next message' },
        ]}
        w="fit-content"
      />
      <Text size="sm">{MODE_DESCRIPTION[mode]}</Text>
    </Stack>
  );
}
