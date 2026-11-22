import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { Chat } from './chat';
import type {
  AgentPendingMessage,
  SessionPendingMessages,
} from './pending-api';

const fixtures = vi.hoisted(() => ({
  session: {
    id: 'session-1',
    title: 'Tracker',
    appIds: [],
    providerId: 'provider-1',
    modelId: 'model-1',
    updatedAt: '2026-11-20T12:00:00.000Z',
    messages: [] as unknown[],
    activeRun: null as null | {
      id: string;
      status: 'running';
      startedAt: string;
      userTurn: number;
      pendingAsk: null;
      pendingEnvRequest: null;
    },
    runs: [] as unknown[],
    retry: null,
    pending: { paused: false, messages: [] } as {
      paused: boolean;
      messages: unknown[];
    },
    serverTime: '2026-11-20T12:00:00.000Z',
    clockOffsetMs: 0,
  },
  providers: [
    {
      id: 'provider-1',
      name: 'Provider',
      apiType: 'openai-responses',
      baseUrl: 'https://example.test/v1',
      enabled: true,
      sortOrder: 0,
      models: [
        {
          id: 'model-row-1',
          modelId: 'model-1',
          name: 'Model one',
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 8_192,
          enabled: true,
          sortOrder: 0,
        },
      ],
    },
  ],
}));

vi.mock('~queries/agent', () => ({
  providersQueryOptions: {
    queryKey: ['test-agent-providers'],
    queryFn: async () => fixtures.providers,
  },
  sessionsQueryOptions: {
    queryKey: ['test-agent-sessions'],
    queryFn: async () => [],
  },
  sessionQueryOptions: (sessionId: string) => ({
    queryKey: ['test-agent-session', sessionId],
    queryFn: async () => structuredClone(fixtures.session),
  }),
}));

vi.mock('~queries/apps', () => ({
  appsQueryOptions: { queryKey: ['test-apps'], queryFn: async () => [] },
}));

vi.mock('~queries/workflows', () => ({
  workflowsQueryOptions: {
    queryKey: ['test-workflows'],
    queryFn: async () => [],
  },
}));

const text = (value: string) => [{ type: 'text' as const, text: value }];

function pendingMessage(
  id: string,
  value: string,
  mode: 'queue' | 'steer' = 'steer',
): AgentPendingMessage {
  return {
    id,
    mode,
    status: 'pending',
    content: text(value),
    text: value,
    images: [],
    attachments: [],
    providerId: 'provider-1',
    modelId: 'model-1',
    createdAt: '2026-11-20T12:00:01.000Z',
    updatedAt: '2026-11-20T12:00:01.000Z',
  };
}

type Call = { method: string; path: string; body?: unknown };

/**
 * Route the chat's requests: the run's event stream stays open (events are
 * pushed by the test) and every pending-message operation answers with the
 * tray `respond` builds, which also becomes the next session snapshot.
 */
function stubFetch(
  respond: (call: Call) => SessionPendingMessages = () =>
    fixtures.session.pending as SessionPendingMessages,
) {
  const calls: Call[] = [];
  let seq = 0;
  let push: ((event: object) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://hatch.example.test');
      if (url.pathname.endsWith('/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              push = (event) => {
                seq += 1;
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ seq, event })}\n\n`),
                );
              };
              init?.signal?.addEventListener(
                'abort',
                () => controller.close(),
                { once: true },
              );
            },
          }),
          { status: 200 },
        );
      }
      const call: Call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) }
          : {}),
      };
      calls.push(call);
      if (url.pathname.includes('/pending')) {
        const pending = respond(call);
        fixtures.session.pending = pending;
        return Response.json({ pending, startedRunId: null });
      }
      throw new Error(`Unexpected fetch: ${call.method} ${call.path}`);
    }),
  );
  return { calls, push: (event: object) => push!(event) };
}

async function renderChat() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <Chat sessionId="session-1" />
      </MantineProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fixtures.session.messages = [
    { role: 'user', content: [{ type: 'text', text: 'Build a tracker' }] },
  ];
  fixtures.session.activeRun = {
    id: 'run-1',
    status: 'running',
    startedAt: '2026-11-20T12:00:00.000Z',
    userTurn: 0,
    pendingAsk: null,
    pendingEnvRequest: null,
  };
  fixtures.session.pending = { paused: false, messages: [] };
});

test('sends a message while the Agent works to the pending tray', async () => {
  const { calls } = stubFetch((call) => ({
    paused: false,
    messages: [
      pendingMessage(
        'pending-1',
        (call.body as { content: { text: string }[] }).content[0].text,
      ),
    ],
  }));
  const screen = await renderChat();
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .toBeVisible();

  await screen.getByRole('textbox', { name: 'Message the Agent…' }).click();
  await userEvent.keyboard('Use blue');
  await userEvent.keyboard('{Enter}');

  const tray = screen.getByRole('region', { name: 'Pending messages' });
  await expect.element(tray.getByText('Use blue')).toBeVisible();
  await expect.element(tray.getByText('Steer')).toBeVisible();
  expect(calls).toEqual([
    {
      method: 'POST',
      path: '/api/agent/sessions/session-1/pending',
      body: {
        content: text('Use blue'),
        images: [],
        attachmentIds: [],
        providerId: 'provider-1',
        modelId: 'model-1',
      },
    },
  ]);
  // The run keeps going: Stop stays available next to Send.
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .toBeVisible();
});

test('edits, sends now and cancels pending messages', async () => {
  fixtures.session.pending = {
    paused: false,
    messages: [
      pendingMessage('pending-1', 'Use blue'),
      pendingMessage('pending-2', 'Deploy it', 'queue'),
    ],
  };
  const { calls } = stubFetch((call) => {
    const messages = fixtures.session.pending.messages as AgentPendingMessage[];
    if (call.method === 'PATCH') {
      const content = (call.body as { content: { text: string }[] }).content;
      return {
        paused: false,
        messages: messages.map((message) =>
          message.id === 'pending-1'
            ? pendingMessage('pending-1', content[0].text)
            : message,
        ),
      };
    }
    const id = call.path.split('/')[6];
    return {
      paused: false,
      messages: messages.filter((message) => message.id !== id),
    };
  });
  const screen = await renderChat();
  const tray = screen.getByRole('region', { name: 'Pending messages' });
  const rows = tray.getByTestId('pending-message');
  await expect.element(rows.nth(1)).toBeVisible();

  await rows.nth(0).getByRole('button', { name: 'Edit message' }).click();
  const editor = tray.getByRole('textbox', { name: 'Edit message…' });
  await expect.element(editor).toBeVisible();
  await editor.click();
  await userEvent.keyboard(' and navy');
  await tray.getByRole('button', { name: 'Save' }).click();
  await expect.element(tray.getByText('Use blue and navy')).toBeVisible();

  await rows.nth(1).getByRole('button', { name: 'Send now' }).click();
  await expect.element(tray.getByText('Deploy it')).not.toBeInTheDocument();

  await tray.getByRole('button', { name: 'Cancel message' }).click();
  await expect
    .element(screen.getByRole('region', { name: 'Pending messages' }))
    .not.toBeInTheDocument();

  expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'PATCH /api/agent/sessions/session-1/pending/pending-1',
    'POST /api/agent/sessions/session-1/pending/pending-2/send-now',
    'DELETE /api/agent/sessions/session-1/pending/pending-1',
  ]);
  expect(calls[0].body).toEqual({
    content: text('Use blue and navy'),
    images: [],
    attachmentIds: [],
  });
});

test('offers Resume when delivery is paused and hides actions while sending', async () => {
  fixtures.session.activeRun = null;
  fixtures.session.pending = {
    paused: true,
    messages: [
      pendingMessage('pending-1', 'Add a chart', 'queue'),
      { ...pendingMessage('pending-2', 'Use blue'), status: 'claimed' },
    ],
  };
  const { calls } = stubFetch(() => ({ paused: false, messages: [] }));
  const screen = await renderChat();
  const tray = screen.getByRole('region', { name: 'Pending messages' });
  await expect.element(tray.getByText(/Paused/)).toBeVisible();
  const claimed = tray.getByTestId('pending-message').nth(1);
  await expect.element(claimed.getByText('Sending…')).toBeVisible();
  await expect
    .element(claimed.getByRole('button', { name: 'Edit message' }))
    .not.toBeInTheDocument();

  await tray.getByRole('button', { name: 'Resume' }).click();
  await expect.element(tray).not.toBeInTheDocument();
  expect(calls).toEqual([
    { method: 'POST', path: '/api/agent/sessions/session-1/pending/resume' },
  ]);
});

test('shows a steered message inside the reply it joined, live and in history', async () => {
  const { push } = stubFetch();
  const screen = await renderChat();
  await vi.waitFor(() => push({ type: 'assistant_start' }));
  push({ type: 'text', delta: 'Working on it.' });
  push({
    type: 'user_message',
    pendingId: 'pending-1',
    text: 'Use blue',
    images: [],
  });
  push({ type: 'assistant_start' });
  push({ type: 'text', delta: 'Switched to blue.' });
  await expect.element(screen.getByText('Switched to blue.')).toBeVisible();
  const live = screen.getByText('Use blue');
  await expect.element(live).toBeVisible();
  // One reply: the steered message sits between its two parts.
  const order = [
    screen.getByText('Working on it.').element(),
    live.element(),
    screen.getByText('Switched to blue.').element(),
  ];
  expect(
    order[0].compareDocumentPosition(order[1]) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    order[1].compareDocumentPosition(order[2]) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

test('keeps reply pairing when history holds a steered message', async () => {
  fixtures.session.activeRun = null;
  fixtures.session.messages = [
    { role: 'user', content: [{ type: 'text', text: 'Build a tracker' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Started.' }],
      stopReason: 'toolUse',
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'Use blue' }],
      steered: true,
      pendingMessageId: 'pending-1',
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Done in blue.' }],
      stopReason: 'stop',
    },
    { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
  ];
  fixtures.session.runs = [
    {
      id: 'run-0',
      status: 'completed',
      userTurn: 0,
      startedAt: '2026-11-20T12:00:00.000Z',
      completedAt: '2026-11-20T12:00:30.000Z',
      error: null,
    },
    {
      id: 'run-1',
      status: 'failed',
      userTurn: 1,
      startedAt: '2026-11-20T12:01:00.000Z',
      completedAt: '2026-11-20T12:01:05.000Z',
      error: 'Provider unavailable',
    },
  ];
  stubFetch();
  const screen = await renderChat();
  await expect.element(screen.getByText('Done in blue.')).toBeVisible();
  await screen
    .getByRole('button', { name: /Worked/ })
    .first()
    .click();
  await expect.element(screen.getByText('Use blue')).toBeVisible();
  // The failure belongs to "Thanks" (user turn 1), not to the steered message.
  await expect.element(screen.getByText('Provider unavailable')).toBeVisible();
  const thanks = screen.getByText('Thanks').element();
  const failure = screen.getByText('Provider unavailable').element();
  expect(
    thanks.compareDocumentPosition(failure) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fixtures.session.runs = [];
});
