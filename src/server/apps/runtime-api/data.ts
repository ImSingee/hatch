import { setTimeout as delay } from 'node:timers/promises';
import {
  appCompatibilityRuntimeMessage,
  type AppCompatibility,
} from '~/app-compatibility';
import { auth } from '~auth/server';
import { db } from '~/db';
import {
  DATA_REQUEST_MAX_BYTES,
  mutateDataTable,
  queryDataTable,
} from '~server/apps/data-table/service';
import { supersededDeploymentSharesDataSchema } from '~server/apps/data-table/deployment-access';
import { subscribeDataChanges } from '~server/apps/data-table/realtime';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  verifyHatchSignature,
} from '~server/secrets';
import { parseAppApiPath } from './path';
import { readDeploymentCompatibility } from '../compatibility';
import { readCappedText } from '~server/http-body';
import { dataErrorResponse } from './data-errors';

const DATA_DEPLOYMENT_HEADER = 'x-hatch-data-deployment';

/**
 * How long a query or mutation waits for a deployment's activation fence to
 * clear before answering 503. A deploy holds the fence only while it migrates
 * and commits, so a request already in flight (in a browser, or in a backend
 * instance that is draining) rides through the cutover instead of failing.
 */
const DATA_ACTIVATION_WAIT_MS = 10_000;
const DATA_ACTIVATION_POLL_MS = 100;

function parse(request: Request): { id: string; action: string } | null {
  const url = new URL(request.url);
  const parsed = parseAppApiPath(url.pathname);
  const match = parsed?.rest.match(/^\/data(?:\/(.*))?$/);
  if (!parsed || !match) return null;
  return { id: parsed.id, action: match[1] ?? '' };
}

/** Who is calling: a signed-in browser, or the App's own backend. */
async function authorize(
  request: Request,
  id: string,
  rawBody: string,
): Promise<'session' | 'backend' | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    const origin = request.headers.get('origin');
    if (request.method !== 'GET' && origin) {
      const expected = new URL(request.url).origin;
      if (origin !== expected) return null;
    }
    return 'session';
  }
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { signingSecret: true },
  });
  if (!app?.signingSecret) return null;
  return verifyHatchSignature({
    secret: app.signingSecret,
    timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(HATCH_SIGNATURE_HEADER),
    payload: rawBody,
  })
    ? 'backend'
    : null;
}

async function liveDataAppState(
  id: string,
  expectedDeploymentId: string,
): Promise<
  | 'missing'
  | 'activating'
  | { state: 'stale'; dataSchemaHash: string | null }
  | 'live'
  | { state: 'unsupported'; compatibility: AppCompatibility | null }
> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      status: true,
      currentDeploymentId: true,
      capabilities: true,
      dataActivationId: true,
      dataSchemaHash: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.dataTable
  ) {
    return 'missing';
  }
  if (app.dataActivationId) return 'activating';
  if (expectedDeploymentId !== app.currentDeploymentId) {
    return { state: 'stale', dataSchemaHash: app.dataSchemaHash ?? null };
  }
  const compatibility = await readDeploymentCompatibility(
    app.currentDeploymentId,
  );
  return compatibility?.isSupported
    ? 'live'
    : { state: 'unsupported', compatibility };
}

function eventStream(
  request: Request,
  id: string,
  expectedDeploymentId: string,
  acceptSupersededDeployment: boolean,
): Response {
  const url = new URL(request.url);
  const rawSince = url.searchParams.get('since');
  const since = rawSince === null ? 0 : Number(rawSince);
  if (
    (rawSince !== null && rawSince.trim() === '') ||
    !Number.isSafeInteger(since) ||
    since < 0
  ) {
    return new Response('Invalid Data Table realtime cursor.', { status: 400 });
  }
  const table = url.searchParams.get('table');
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      };
      request.signal.addEventListener('abort', close, { once: true });
      controller.enqueue(encoder.encode(': connected\n\n'));
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, 20_000);
      heartbeat.unref?.();

      void subscribeDataChanges({
        id,
        since,
        table,
        expectedDeploymentId,
        acceptSupersededDeployment,
        send(event) {
          if (closed) return;
          if ('reset' in event) {
            controller.enqueue(
              encoder.encode(
                `id: ${event.seq}\nevent: reset\ndata: {"reset":true}\n\n`,
              ),
            );
            return;
          }
          controller.enqueue(
            encoder.encode(
              `id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(
                event,
              )}\n\n`,
            ),
          );
        },
        close,
      })
        .then((stop) => {
          if (closed) stop();
          else unsubscribe = stop;
        })
        .catch((error) => {
          if (!closed) controller.error(error);
          close();
        });
    },
    cancel() {
      closed = true;
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export async function handleDataRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const parsed = parse(request);
  if (!parsed) return new Response('Not found', { status: 404 });
  const expectedDeploymentId =
    request.headers.get(DATA_DEPLOYMENT_HEADER) ?? '';
  let state = await liveDataAppState(parsed.id, expectedDeploymentId);
  if (state === 'activating' && request.method === 'POST') {
    const deadline = Date.now() + DATA_ACTIVATION_WAIT_MS;
    while (
      state === 'activating' &&
      Date.now() < deadline &&
      !request.signal.aborted
    ) {
      await delay(DATA_ACTIVATION_POLL_MS);
      state = await liveDataAppState(parsed.id, expectedDeploymentId);
    }
  }
  if (state === 'missing') {
    return new Response('Not found', { status: 404 });
  }
  if (state === 'activating') {
    return new Response('Data Table deployment is being finalized.', {
      status: 503,
      headers: { 'retry-after': '1' },
    });
  }
  const staleResponse = () =>
    new Response(
      'This Data client belongs to an inactive deployment. Reload or restart it.',
      { status: 409 },
    );
  const stale = typeof state === 'object' && state.state === 'stale';
  // Only an App backend may outlive its deployment (a retired instance
  // finishing in-flight requests), and backends always sign. Anything else
  // is rejected before its body is read, as before.
  if (stale && !request.headers.has(HATCH_SIGNATURE_HEADER)) {
    return staleResponse();
  }
  if (typeof state === 'object' && state.state === 'unsupported') {
    return new Response(appCompatibilityRuntimeMessage(state.compatibility), {
      status: 503,
    });
  }

  const rawBody =
    request.method === 'GET'
      ? ''
      : await readCappedText(request, DATA_REQUEST_MAX_BYTES);
  if (rawBody === null)
    return new Response('Payload too large', { status: 413 });
  const caller = await authorize(request, parsed.id, rawBody);
  if (!caller) {
    return new Response('Unauthorized', { status: 401 });
  }
  const acceptSupersededDeployment = caller === 'backend';
  if (
    typeof state === 'object' &&
    state.state === 'stale' &&
    !(
      acceptSupersededDeployment &&
      (await supersededDeploymentSharesDataSchema(
        parsed.id,
        expectedDeploymentId,
        state.dataSchemaHash,
      ))
    )
  ) {
    return staleResponse();
  }
  const access = { expectedDeploymentId, acceptSupersededDeployment };

  try {
    if (request.method === 'GET' && parsed.action === 'events') {
      return eventStream(
        request,
        parsed.id,
        expectedDeploymentId,
        acceptSupersededDeployment,
      );
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }
    if (parsed.action === 'query') {
      return Response.json(await queryDataTable(parsed.id, body, access));
    }
    if (parsed.action === 'mutate') {
      return Response.json(await mutateDataTable(parsed.id, body, access));
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    const response = dataErrorResponse(error);
    if (response.status === 503) response.headers.set('retry-after', '1');
    return response;
  }
}
