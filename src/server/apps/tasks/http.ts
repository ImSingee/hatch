/**
 * Server-only: the two HTTP entry points that start App task runs.
 *
 *   GET|POST /api/app/<id>/tasks/<name>/run → 202 { runId, status }
 *     Webhook trigger, for tasks that enable it. Authenticated like the App
 *     webhook in `platform` mode (native credential, per-App secret or a
 *     same-origin session). POST takes a JSON object body; GET takes query
 *     parameters, coerced toward the input schema.
 *
 *   POST /api/app/<id>/tasks/enqueue { task, input } → 202 { runId, status }
 *     Called by the App's own backend, signed like KV and notifications
 *     (HMAC over `<timestamp>.<rawBody>` with the per-App signing secret), so
 *     an App can only start its own tasks.
 */
import { db } from '~/db';
import type { NormalizedManifest } from '~server/apps/manifest';
import { AppError } from '~server/errors';
import { readCappedText } from '~server/http-body';
import { coerceSchemaQueryInput } from '~server/json-schema-input';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  verifyHatchSignature,
} from '~server/secrets';
import { authenticateAppWebhook } from '../webhook-auth';
import { MAX_TASK_INPUT_BYTES, startTaskRun } from './service';

/** The task input cap, which matches other inbound webhook bodies. */
const MAX_TASK_BODY_BYTES = MAX_TASK_INPUT_BYTES;

export function accepted(result: { runId: string; status: string }): Response {
  return Response.json(
    { runId: result.runId, status: result.status },
    { status: 202 },
  );
}

/** Caller-facing 4xx text; never echo internal detail on a public endpoint. */
export function failure(error: unknown, label: string): Response {
  if (error instanceof AppError && error.status !== 500) {
    return new Response(error.message, { status: error.status });
  }
  console.error(`[tasks] ${label} failed to start:`, error);
  return new Response('Task error', { status: 502 });
}

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await readCappedText(request, MAX_TASK_BODY_BYTES);
  if (text === null) {
    return {
      ok: false,
      response: new Response('Payload too large', { status: 413 }),
    };
  }
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: new Response('Request body must be JSON', { status: 400 }),
    };
  }
}

export async function handleTaskWebhook({
  request,
  params,
}: {
  request: Request;
  params: { appId: string; taskName: string };
}): Promise<Response> {
  const app = await db.query.apps.findFirst({
    where: { id: params.appId },
    columns: {
      id: true,
      status: true,
      capabilities: true,
      currentDeploymentId: true,
      webhookSecret: true,
    },
  });
  if (!app || app.status === 'archived' || !app.currentDeploymentId) {
    return new Response('Not found', { status: 404 });
  }
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
    columns: { manifestNormalized: true },
  });
  const task = (
    deployment?.manifestNormalized as NormalizedManifest | null
  )?.tasks?.definitions.find((t) => t.name === params.taskName);
  if (!app.capabilities?.tasks || !task?.webhook) {
    return new Response('Webhook not enabled', { status: 404 });
  }

  const authenticated = await authenticateAppWebhook(
    request,
    app.webhookSecret,
  );
  if (!authenticated.ok) return authenticated.response;

  let input: unknown;
  if (request.method === 'POST') {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    input = body.value;
  } else {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    delete query.secret;
    input = coerceSchemaQueryInput(task.inputSchema, query);
  }
  try {
    return accepted(
      await startTaskRun(app.id, task.name, {
        trigger: 'webhook',
        input,
        actor: authenticated.actor,
        requireWebhook: true,
      }),
    );
  } catch (error) {
    return failure(error, `App ${app.id} task ${task.name} webhook`);
  }
}

export async function handleTaskEnqueue({
  request,
  params,
}: {
  request: Request;
  params: { appId: string };
}): Promise<Response> {
  const app = await db.query.apps.findFirst({
    where: { id: params.appId },
    columns: {
      id: true,
      status: true,
      capabilities: true,
      currentDeploymentId: true,
      signingSecret: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.tasks ||
    !app.signingSecret
  ) {
    return new Response('Not found', { status: 404 });
  }
  const rawBody = await readCappedText(request, MAX_TASK_BODY_BYTES);
  if (rawBody === null) {
    return new Response('Payload too large', { status: 413 });
  }
  const verified = verifyHatchSignature({
    secret: app.signingSecret,
    timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(HATCH_SIGNATURE_HEADER),
    payload: rawBody,
  });
  if (!verified) return new Response('Forbidden', { status: 403 });

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return new Response('Body must be JSON', { status: 400 });
  }
  const body = json as { task?: unknown; input?: unknown } | null;
  if (!body || typeof body !== 'object' || typeof body.task !== 'string') {
    return new Response('Body must be { "task": string, "input"?: object }', {
      status: 400,
    });
  }
  try {
    return accepted(
      await startTaskRun(app.id, body.task, {
        trigger: 'app',
        input: body.input ?? {},
      }),
    );
  } catch (error) {
    return failure(error, `App ${app.id} task ${body.task} enqueue`);
  }
}
