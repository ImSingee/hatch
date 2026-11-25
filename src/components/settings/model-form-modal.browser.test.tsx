import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { ProviderModel, ProviderWithModels } from '~server/providers';
import { ModelFormModal } from './model-form-modal';

const catalogHit = {
  providerId: 'anthropic',
  providerName: 'Anthropic',
  model: {
    id: 'claude-big',
    name: 'Claude Big',
    kind: 'chat' as const,
    reasoning: true,
    thinkingLevels: ['low', 'medium', 'high'],
    contextWindow: 1_000_000,
    maxTokens: 900_000,
  },
};

vi.mock('~server/providers', () => ({
  updateModel: vi.fn<() => Promise<unknown>>(),
  fetchProviderModels: vi.fn<() => Promise<unknown>>(),
  searchCatalog: vi.fn<() => Promise<unknown>>(async () => ({
    models: [catalogHit],
    total: 1,
  })),
}));

vi.mock('~queries/agent', () => ({
  providersQueryOptions: { queryKey: ['test-providers'] },
  agentModelChoicesQueryOptions: { queryKey: ['test-model-choices'] },
}));

const model: ProviderModel = {
  id: 'model-1',
  providerId: 'provider-1',
  providerName: 'Local',
  kind: 'chat',
  modelId: 'my-model',
  name: 'My model',
  description: '',
  enabled: true,
  sortOrder: 0,
  catalogRef: null,
  inCatalog: false,
  catalogLabel: null,
  overrides: { reasoning: null, contextWindow: null, maxTokens: null },
  chat: {
    reasoning: false,
    thinkingLevels: [],
    defaultThinkingLevel: 'off',
    contextWindow: 128_000,
    maxTokens: 8192,
    overridden: [],
    catalogValues: {},
  },
};

const provider = {
  id: 'provider-1',
  name: 'Local',
  canGenerateImages: false,
  imageModelSuggestions: [],
  models: [model],
} as unknown as ProviderWithModels;

test('blank fields describe the catalog entry chosen in the form', async () => {
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <MantineProvider>
        <ModelFormModal
          opened
          onClose={vi.fn<() => void>()}
          provider={provider}
          model={model}
        />
      </MantineProvider>
    </QueryClientProvider>,
  );

  // No catalog: Hatch's defaults.
  await expect.element(screen.getByText('Blank uses 128,000')).toBeVisible();
  await expect.element(screen.getByText('Blank uses 8,192')).toBeVisible();

  await screen.getByRole('button', { name: 'Link' }).click();
  await screen.getByRole('textbox', { name: 'Search models' }).fill('claude');
  await screen.getByRole('option', { name: /Claude Big/ }).click();

  // The linked entry's values, its max output capped at half the context.
  await expect.element(screen.getByText('Catalog: 1,000,000')).toBeVisible();
  await expect.element(screen.getByText('Catalog: 500,000')).toBeVisible();
  await expect
    .element(screen.getByLabelText('Reasoning', { exact: true }).first())
    .toHaveValue('Follow catalog (on)');

  // A typed context window moves the cap with it.
  await screen.getByRole('textbox', { name: 'Context window' }).fill('200000');
  await expect.element(screen.getByText('Catalog: 100,000')).toBeVisible();

  await screen.getByRole('button', { name: 'Unlink' }).click();
  await expect.element(screen.getByText('Blank uses 128,000')).toBeVisible();
  await expect.element(screen.getByText('Blank uses 8,192')).toBeVisible();
});
