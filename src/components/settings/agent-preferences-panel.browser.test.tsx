import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { AgentPreferenceSettings } from '~server/agent-preference-settings';
import { AgentPreferencesPanel } from './agent-preferences-panel';

const fixture = vi.hoisted(() => ({
  saved: {
    userId: 'a',
    messageMode: 'steer',
    defaultModel: null,
  } as AgentPreferenceSettings,
  saveFailure: false,
  update:
    vi.fn<
      (input: {
        data: { messageMode: 'queue' | 'steer' };
      }) => Promise<AgentPreferenceSettings>
    >(),
  success: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
}));
vi.mock('~auth/client', () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: 'a' } }, isPending: false }),
  },
}));
vi.mock('sonner', () => ({
  toast: { success: fixture.success, error: fixture.error },
}));
vi.mock('~queries/agent', async () => {
  const { choicesFrom } =
    await import('~components/agent/model-choices.fixture');
  return {
    agentModelChoicesQueryOptions: {
      queryKey: ['test-agent-model-choices'],
      queryFn: async () => choicesFrom([]),
    },
  };
});
vi.mock('~server/agent-preference-settings', () => ({
  getAgentPreferenceSettings: async () => fixture.saved,
  updateAgentPreferenceSettings: fixture.update,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.saved = { userId: 'a', messageMode: 'steer', defaultModel: null };
  fixture.saveFailure = false;
  fixture.update.mockImplementation(async ({ data }) => {
    if (fixture.saveFailure) throw new Error('Save request failed');
    fixture.saved = { userId: 'a', defaultModel: null, ...data };
    return fixture.saved;
  });
});

async function panel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MantineProvider>
        <AgentPreferencesPanel />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

test('saves the chosen mode and keeps the saved one when saving fails', async () => {
  const screen = await panel();
  const steer = screen.getByRole('radio', { name: 'Steer the current reply' });
  const queue = screen.getByRole('radio', {
    name: 'Queue as the next message',
  });
  await expect.element(steer).toBeChecked();

  await screen.getByText('Queue as the next message').click();
  await expect.element(queue).toBeChecked();
  expect(fixture.update).toHaveBeenCalledWith({
    data: { messageMode: 'queue' },
  });
  expect(fixture.success).toHaveBeenCalledOnce();
  await expect
    .element(screen.getByText(/waits until the current reply finishes/))
    .toBeVisible();

  fixture.saveFailure = true;
  await screen.getByText('Steer the current reply').click();
  await vi.waitFor(() => expect(fixture.error).toHaveBeenCalledOnce());
  await expect.element(queue).toBeChecked();
});
