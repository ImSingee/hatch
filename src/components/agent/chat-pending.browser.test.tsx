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
          kind: 'chat',
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
        clientMessageId: expect.any(String),
      },
    },
  ]);
  // The run keeps going: Stop stays available next to Send.
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .toBeVisible();
});

test('resends a draft whose response was lost as the same message', async () => {
  let lost = true;
  const { calls } = stubFetch((call) => {
    if (lost) {
      // The server took the message; its response never arrived.
      lost = false;
      throw new TypeError('Failed to fetch');
    }
    const body = call.body as { content: { text: string }[] };
    return {
      paused: false,
      messages: [pendingMessage('pending-1', body.content[0].text)],
    };
  });
  const screen = await renderChat();
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  await userEvent.keyboard('Use blue');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => calls.length).toBe(1);
  // The draft is kept; sending it again names the same message.
  await expect.element(input).toHaveTextContent('Use blue');
  await userEvent.keyboard('{Enter}');
  const tray = screen.getByRole('region', { name: 'Pending messages' });
  await expect.element(tray.getByText('Use blue')).toBeVisible();

  await input.click();
  await userEvent.keyboard('And dark');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => calls.length).toBe(3);
  const ids = calls.map(
    (call) => (call.body as { clientMessageId: string }).clientMessageId,
  );
  expect(ids[1]).toBe(ids[0]);
  // A new draft is a new message.
  expect(ids[2]).not.toBe(ids[0]);
});

test('resends a draft whose files the lost send already attached', async () => {
  const uploads: string[] = [];
  const enqueued: { clientMessageId: string; attachmentIds: string[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://hatch.example.test');
      if (url.pathname.endsWith('/events')) {
        return new Response(new ReadableStream(), { status: 200 });
      }
      if (url.pathname.includes('/attachments/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        uploads.push(id);
        // The first send attached it before its response was lost.
        if (uploads.length > 1) {
          return new Response('Attachment id is already in use.', {
            status: 409,
          });
        }
        return Response.json({
          attachment: {
            id,
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 3,
          },
        });
      }
      if (url.pathname.endsWith('/pending')) {
        enqueued.push(JSON.parse(String(init?.body)));
        if (enqueued.length === 1) throw new TypeError('Failed to fetch');
        return Response.json({
          pending: { paused: false, messages: [] },
          startedRunId: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    }),
  );
  const screen = await renderChat();
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .toBeVisible();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing attachment input');
  const transfer = new DataTransfer();
  transfer.items.add(new File(['abc'], 'notes.txt', { type: 'text/plain' }));
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: transfer.files,
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await expect.element(screen.getByText('notes.txt')).toBeVisible();

  const send = screen.getByRole('button', { name: 'Send' });
  await send.click();
  await expect.poll(() => enqueued.length).toBe(1);
  await expect.element(screen.getByText('notes.txt')).toBeVisible();
  await send.click();
  await expect.poll(() => enqueued.length).toBe(2);

  // Uploaded again (a pruned upload would come back); the one in use is
  // still sent as the same message with the same attachment.
  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toBe(uploads[0]);
  expect(enqueued[1]).toMatchObject({
    clientMessageId: enqueued[0].clientMessageId,
    attachmentIds: [uploads[0]],
  });
  expect(enqueued[0].attachmentIds).toEqual([uploads[0]]);
});

test('uploads a file again for an edited draft the lost send attached', async () => {
  const attached = new Set<string>();
  const uploads: string[] = [];
  const enqueued: { clientMessageId: string; attachmentIds: string[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://hatch.example.test');
      if (url.pathname.endsWith('/events')) {
        return new Response(new ReadableStream(), { status: 200 });
      }
      if (url.pathname.includes('/attachments/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
        uploads.push(id);
        if (attached.has(id)) {
          return new Response('Attachment id is already in use.', {
            status: 409,
          });
        }
        return Response.json({
          attachment: {
            id,
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 3,
          },
        });
      }
      if (url.pathname.endsWith('/pending')) {
        const body = JSON.parse(String(init?.body));
        enqueued.push(body);
        // The server took the first send and attached its file.
        for (const id of body.attachmentIds) attached.add(id);
        if (enqueued.length === 1) throw new TypeError('Failed to fetch');
        return Response.json({
          pending: { paused: false, messages: [] },
          startedRunId: null,
        });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    }),
  );
  const screen = await renderChat();
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .toBeVisible();
  const fileInput =
    document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) throw new Error('Missing attachment input');
  const transfer = new DataTransfer();
  transfer.items.add(new File(['abc'], 'notes.txt', { type: 'text/plain' }));
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: transfer.files,
  });
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  await expect.element(screen.getByText('notes.txt')).toBeVisible();
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  await userEvent.keyboard('Read this');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => enqueued.length).toBe(1);

  // Edited: a new message, which cannot share the first one's upload.
  await input.click();
  await userEvent.keyboard(' too');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => enqueued.length).toBe(2);
  expect(uploads).toHaveLength(3);
  expect(uploads[1]).toBe(uploads[0]);
  expect(uploads[2]).not.toBe(uploads[0]);
  expect(enqueued[1].clientMessageId).not.toBe(enqueued[0].clientMessageId);
  expect(enqueued[1].attachmentIds).toEqual([uploads[2]]);
});

test('settles a resend the server says already waits in the tray', async () => {
  // Stopped with delivery paused; the message an earlier send queued waits.
  fixtures.session.activeRun = null;
  fixtures.session.pending = {
    paused: true,
    messages: [pendingMessage('pending-1', 'Use blue')],
  };
  const starts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://hatch.example.test');
      if (url.pathname === '/api/agent/runs') {
        starts.push(JSON.parse(String(init?.body)));
        return Response.json({ queued: true });
      }
      throw new Error(`Unexpected fetch: ${url.pathname}`);
    }),
  );
  const screen = await renderChat();
  const input = screen.getByRole('textbox', { name: 'Message the Agent…' });
  await input.click();
  await userEvent.keyboard('Use blue');
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => starts.length).toBe(1);
  // Accepted: the draft clears and no run is followed.
  await expect.element(input).toHaveTextContent('');
  await expect
    .element(screen.getByRole('button', { name: 'Stop' }))
    .not.toBeInTheDocument();
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

test('closes an open edit once the run takes the message in', async () => {
  fixtures.session.pending = {
    paused: false,
    messages: [
      pendingMessage('pending-1', 'Use blue'),
      pendingMessage('pending-2', 'Deploy it', 'queue'),
    ],
  };
  // Cancelling the second message returns a tray where the run has already
  // claimed the first one.
  stubFetch(() => ({
    paused: false,
    messages: [
      { ...pendingMessage('pending-1', 'Use blue'), status: 'claimed' },
    ],
  }));
  const screen = await renderChat();
  const tray = screen.getByRole('region', { name: 'Pending messages' });
  const rows = tray.getByTestId('pending-message');
  await rows.nth(0).getByRole('button', { name: 'Edit message' }).click();
  await expect
    .element(tray.getByRole('textbox', { name: 'Edit message…' }))
    .toBeVisible();

  await rows.nth(1).getByRole('button', { name: 'Cancel message' }).click();
  await expect.element(tray.getByText('Sending…')).toBeVisible();
  await expect
    .element(tray.getByRole('textbox', { name: 'Edit message…' }))
    .not.toBeInTheDocument();
  await expect
    .element(tray.getByRole('button', { name: 'Save' }))
    .not.toBeInTheDocument();
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

test('shows a steered message as its own message between the work around it', async () => {
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
  // The steered message stands apart: the work before it is finished and
  // framed on its own, and the reply goes on below it.
  await expect
    .element(screen.getByRole('button', { name: /Working/ }))
    .toBeVisible();
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
      injectedAt: '2026-11-20T12:00:10.000Z',
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
  // The steered message is a message of its own, and the work before and
  // after it is timed apart: start to injection, injection to end.
  await expect.element(screen.getByText('Use blue')).toBeVisible();
  await expect.element(screen.getByText('10s', { exact: true })).toBeVisible();
  await expect.element(screen.getByText('20s', { exact: true })).toBeVisible();
  const order = [
    screen.getByText('Started.').element(),
    screen.getByText('Use blue').element(),
    screen.getByText('20s', { exact: true }).element(),
    screen.getByText('Done in blue.').element(),
  ];
  for (let index = 1; index < order.length; index += 1) {
    expect(
      order[index - 1].compareDocumentPosition(order[index]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  // The failure belongs to "Thanks" (user turn 1), not to the steered message.
  await expect.element(screen.getByText('Provider unavailable')).toBeVisible();
  const thanks = screen.getByText('Thanks').element();
  const failure = screen.getByText('Provider unavailable').element();
  expect(
    thanks.compareDocumentPosition(failure) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fixtures.session.runs = [];
});

test('shows the images of a steered message once the run takes it in', async () => {
  fixtures.session.pending = {
    paused: false,
    messages: [
      {
        ...pendingMessage('pending-1', ''),
        images: [{ data: 'aW1hZ2U=', mimeType: 'image/png' }],
      },
    ],
  };
  const { push } = stubFetch();
  const screen = await renderChat();
  await expect
    .element(screen.getByRole('region', { name: 'Pending messages' }))
    .toBeVisible();
  await vi.waitFor(() => push({ type: 'assistant_start' }));
  push({
    type: 'user_message',
    pendingId: 'pending-1',
    text: '',
    images: [{ mimeType: 'image/png' }],
  });
  await expect
    .element(screen.getByRole('img', { name: 'Attached image' }))
    .toBeVisible();
});
