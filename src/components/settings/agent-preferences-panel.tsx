import {
  Alert,
  Button,
  Group,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { authClient } from '~auth/client';
import type { AgentMessageMode, AgentThinkingLevel } from '~/db/schema';
import { agentPreferencesQueryOptions } from '~queries/agent-preferences';
import { agentModelChoicesQueryOptions } from '~queries/agent';
import { ModelPicker } from '~components/agent/model-picker';
import { splitModelValue } from '~components/agent/model-value';
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
    <Stack gap="xl">
      <DefaultModel />
      <Stack gap="md">
        <Stack gap={2}>
          <Text fw={600} id="agent-message-mode-label">
            Messages sent while the Agent works
          </Text>
          <Text size="sm" c="dimmed">
            Choose what happens when you send a message before the Agent has
            finished replying. Waiting messages can still be edited, cancelled
            or sent right away.
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
    </Stack>
  );
}

/** The model and thinking level new chats start with, on every device. */
function DefaultModel() {
  const queryClient = useQueryClient();
  const choices = useQuery(agentModelChoicesQueryOptions);
  const save = useMutation({
    mutationFn: (
      defaultModel: {
        providerId: string;
        modelId: string;
        thinkingLevel: AgentThinkingLevel;
      } | null,
    ) => updateAgentPreferenceSettings({ data: { defaultModel } }),
    meta: { errorToast: false },
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: agentModelChoicesQueryOptions.queryKey,
      });
      toast.success('Default model updated');
    },
    onError: (error) =>
      toast.error(error.message || 'Could not update the default model.'),
  });
  if (!choices.data) return <Skeleton height={56} />;
  const { defaultModel, providers, savedDefault } = choices.data;
  const groups = providers.map((provider) => ({
    id: provider.id,
    group: provider.name,
    catalogProviderId: provider.catalogProviderId,
    items: provider.models.map((model) => ({
      value: `${provider.id}:${model.modelId}`,
      label: model.name,
      thinkingLevels: model.thinkingLevels,
      defaultThinkingLevel: model.defaultThinkingLevel,
    })),
  }));

  return (
    <Stack gap="xs">
      <Stack gap={2}>
        <Text fw={600}>Default model</Text>
        <Text size="sm" c="dimmed">
          New chats start with this model and thinking level, on the web and in
          the mobile app. Picking a model in a chat also makes it the default.
        </Text>
      </Stack>
      <Group gap="xs">
        <ModelPicker
          groups={groups}
          value={
            defaultModel
              ? `${defaultModel.providerId}:${defaultModel.modelId}`
              : null
          }
          thinkingLevel={defaultModel?.thinkingLevel ?? null}
          disabled={save.isPending}
          onChange={(value, thinkingLevel) => {
            const parsed = splitModelValue(value);
            if (parsed) save.mutate({ ...parsed, thinkingLevel });
          }}
        />
        {savedDefault ? (
          <Button
            type="button"
            size="xs"
            variant="subtle"
            color="gray"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Use the first model
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
