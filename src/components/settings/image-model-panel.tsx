import {
  Alert,
  Autocomplete,
  Button,
  Group,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { imageModelQueryOptions } from '~queries/app-icons';
import { clearImageModelFn, setImageModelFn } from '~server/app-icons';

/** Choose the one image-generation model the Agent uses, or none. */
export function ImageModelPanel() {
  const queryClient = useQueryClient();
  const { data: state } = useSuspenseQuery(imageModelQueryOptions);
  const [providerId, setProviderId] = useState<string | null>(
    state.selected?.providerId ?? state.providers[0]?.id ?? null,
  );
  const [modelId, setModelId] = useState(state.selected?.modelId ?? '');
  const provider = state.providers.find((item) => item.id === providerId);
  const done = async (message: string) => {
    await queryClient.invalidateQueries({
      queryKey: imageModelQueryOptions.queryKey,
    });
    toast.success(message);
  };

  const save = useMutation({
    mutationFn: () =>
      setImageModelFn({
        data: { providerId: providerId ?? '', modelId: modelId.trim() },
      }),
    onSuccess: () => done('Image model saved'),
  });
  const clear = useMutation({
    mutationFn: () => clearImageModelFn(),
    onSuccess: async () => {
      setModelId('');
      await done('Image model cleared');
    },
  });

  return (
    <div>
      <Stack gap="sm">
        <Stack gap={2}>
          <Text fw={700}>Image model</Text>
          <Text size="sm" c="dimmed">
            Lets the Agent generate images, such as app icons. Uses the API key
            of the provider you pick.
          </Text>
        </Stack>
        {state.providers.length === 0 ? (
          <Text size="sm" c="dimmed">
            None of your providers can generate images. Add an OpenAI provider
            first.
          </Text>
        ) : (
          <>
            {state.selected && !state.selected.usable ? (
              <Alert
                color="yellow"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
              >
                {state.selected.providerName} is disabled or has no API key, so
                image generation is unavailable.
              </Alert>
            ) : null}
            <Group grow align="flex-start">
              <Select
                label="Provider"
                allowDeselect={false}
                data={state.providers.map((item) => ({
                  value: item.id,
                  label: item.enabled ? item.name : `${item.name} (disabled)`,
                }))}
                value={providerId}
                onChange={setProviderId}
              />
              <Autocomplete
                label="Model ID"
                placeholder={provider?.suggestedModels[0]}
                data={provider?.suggestedModels ?? []}
                value={modelId}
                onChange={setModelId}
              />
            </Group>
            <Group justify="flex-end" gap="xs">
              {state.selected ? (
                <Button
                  variant="subtle"
                  color="gray"
                  loading={clear.isPending}
                  onClick={() => clear.mutate()}
                >
                  Clear
                </Button>
              ) : null}
              <Button
                disabled={!providerId || !modelId.trim()}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </div>
  );
}
