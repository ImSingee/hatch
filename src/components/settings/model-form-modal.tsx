import {
  Anchor,
  Autocomplete,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  agentModelChoicesQueryOptions,
  providersQueryOptions,
} from '~queries/agent';
import {
  updateModel,
  type ProviderModel,
  type ProviderWithModels,
} from '~server/providers';
import { ModelSearchInput } from './model-search-input';
import classes from './providers-panel.module.css';

type ReasoningChoice = 'catalog' | 'on' | 'off';

type Values = {
  kind: ProviderModel['kind'];
  modelId: string;
  name: string;
  description: string;
  /** Empty follows the catalog. */
  contextWindow: number | '';
  maxTokens: number | '';
  reasoning: ReasoningChoice;
};

const KIND_LABELS: Record<ProviderModel['kind'], string> = {
  chat: 'Chat',
  image: 'Image',
};

function reasoningChoice(value: boolean | null): ReasoningChoice {
  return value === null ? 'catalog' : value ? 'on' : 'off';
}

/**
 * Edit one model. Context window, max output and reasoning follow the
 * catalog while left blank (or "Follow catalog"); a value overrides it.
 */
export function ModelFormModal({
  opened,
  onClose,
  provider,
  model,
}: {
  opened: boolean;
  onClose: () => void;
  provider: ProviderWithModels;
  model: ProviderModel;
}) {
  const qc = useQueryClient();
  // undefined = keep; null = detach; string = use this entry.
  const [catalogRef, setCatalogRef] = useState<string | null | undefined>(
    undefined,
  );
  const [pickedLabel, setPickedLabel] = useState<string | null>(null);
  const [changingRef, setChangingRef] = useState(false);
  const form = useForm<Values>({
    initialValues: {
      kind: model.kind,
      modelId: model.modelId,
      name: model.name,
      description: model.description,
      contextWindow: model.overrides.contextWindow ?? '',
      maxTokens: model.overrides.maxTokens ?? '',
      reasoning: reasoningChoice(model.overrides.reasoning),
    },
    validate: {
      modelId: (v) => (v.trim() ? null : 'Required'),
      description: (v) =>
        Array.from(v.trim()).length > 200 ? 'At most 200 characters' : null,
    },
  });
  const image = form.values.kind === 'image';
  const ref = catalogRef === undefined ? model.catalogRef : catalogRef;
  const linked = ref !== null && (catalogRef !== undefined || model.inCatalog);
  const catalogValues = model.chat?.catalogValues ?? {};

  const mutation = useMutation({
    mutationFn: (values: Values) =>
      updateModel({
        data: {
          id: model.id,
          kind: values.kind,
          modelId: values.modelId,
          name: values.name,
          description: values.description,
          ...(catalogRef === undefined ? {} : { catalogRef }),
          ...(values.kind === 'chat'
            ? {
                contextWindow:
                  values.contextWindow === '' ? null : values.contextWindow,
                maxTokens: values.maxTokens === '' ? null : values.maxTokens,
                reasoning:
                  values.reasoning === 'catalog'
                    ? null
                    : values.reasoning === 'on',
              }
            : {}),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: providersQueryOptions.queryKey }),
        qc.invalidateQueries({
          queryKey: agentModelChoicesQueryOptions.queryKey,
        }),
      ]);
      toast.success('Model updated');
      onClose();
    },
  });

  const resetAll = () =>
    form.setValues({ contextWindow: '', maxTokens: '', reasoning: 'catalog' });

  const followLabel =
    catalogValues.reasoning === undefined
      ? 'Follow catalog'
      : `Follow catalog (${catalogValues.reasoning ? 'on' : 'off'})`;

  return (
    <Modal opened={opened} onClose={onClose} title="Edit model" centered>
      <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
        <Stack gap="sm">
          <Group grow align="flex-start">
            <Select
              label="Category"
              allowDeselect={false}
              data={[
                { value: 'chat', label: KIND_LABELS.chat },
                {
                  value: 'image',
                  label: KIND_LABELS.image,
                  disabled: !provider.canGenerateImages,
                },
              ]}
              {...form.getInputProps('kind')}
            />
            {image ? (
              <Autocomplete
                label="Model ID"
                data={provider.imageModelSuggestions}
                {...form.getInputProps('modelId')}
              />
            ) : (
              <TextInput label="Model ID" {...form.getInputProps('modelId')} />
            )}
          </Group>
          <div className={classes.match}>
            <div className={classes.matchText}>
              <Text size="sm" fw={700} truncate>
                {linked && ref
                  ? `Catalog: ${
                      (catalogRef === undefined
                        ? model.catalogLabel
                        : pickedLabel) ?? ref
                    }`
                  : 'No catalog details'}
              </Text>
              <Text size="xs" c="dimmed">
                {linked
                  ? 'Values left blank follow the catalog.'
                  : 'Hatch uses the values below, or its defaults.'}
              </Text>
            </div>
            <Group gap="xs" wrap="nowrap">
              <Anchor
                component="button"
                type="button"
                size="sm"
                fw={700}
                onClick={() => setChangingRef((open) => !open)}
              >
                {linked ? 'Change' : 'Link'}
              </Anchor>
              {linked ? (
                <Anchor
                  component="button"
                  type="button"
                  size="sm"
                  fw={700}
                  onClick={() => setCatalogRef(null)}
                >
                  Unlink
                </Anchor>
              ) : null}
            </Group>
          </div>
          {changingRef ? (
            <ModelSearchInput
              catalogProviderId={null}
              exclude={new Set()}
              focusOnMount
              placeholder="Search the catalog"
              onPick={(picked) => {
                if (!picked.catalogRef) return;
                setCatalogRef(picked.catalogRef);
                setPickedLabel(picked.name);
                setChangingRef(false);
              }}
            />
          ) : null}
          <TextInput
            label="Display name"
            description="Optional — defaults to the catalog name, then the model ID"
            placeholder={form.values.modelId.trim()}
            {...form.getInputProps('name')}
          />
          {image ? (
            <Textarea
              label="Best for"
              description="Optional — helps the Agent choose between image models"
              placeholder="Fast, cheap drafts"
              autosize
              minRows={2}
              maxRows={4}
              {...form.getInputProps('description')}
            />
          ) : (
            <>
              <Group grow align="flex-start">
                <NumberInput
                  label="Context window"
                  min={1000}
                  step={1000}
                  thousandSeparator=","
                  placeholder={
                    catalogValues.contextWindow ? 'Follow catalog' : 'Default'
                  }
                  description={
                    catalogValues.contextWindow
                      ? `Catalog: ${catalogValues.contextWindow.toLocaleString('en-US')}`
                      : 'Blank uses 128,000'
                  }
                  {...form.getInputProps('contextWindow')}
                />
                <NumberInput
                  label="Max output tokens"
                  min={256}
                  step={256}
                  thousandSeparator=","
                  placeholder={
                    catalogValues.maxTokens ? 'Follow catalog' : 'Default'
                  }
                  description={
                    catalogValues.maxTokens
                      ? `Catalog: ${catalogValues.maxTokens.toLocaleString('en-US')}`
                      : 'Blank uses 8,192'
                  }
                  {...form.getInputProps('maxTokens')}
                />
              </Group>
              <Select
                label="Reasoning"
                description="Reasoning models offer thinking levels in the model picker"
                allowDeselect={false}
                data={[
                  { value: 'catalog', label: followLabel },
                  { value: 'on', label: 'On' },
                  { value: 'off', label: 'Off' },
                ]}
                {...form.getInputProps('reasoning')}
              />
            </>
          )}
          <Group justify="space-between" mt="xs">
            {image ? (
              <span />
            ) : (
              <Button
                type="button"
                variant="subtle"
                color="gray"
                onClick={resetAll}
              >
                Reset to catalog
              </Button>
            )}
            <Group gap="xs">
              <Button type="button" variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                Save
              </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
