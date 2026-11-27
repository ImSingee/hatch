import { db } from '~/db';
import { assertSupportedDeployment } from '~server/apps/compatibility';
import type { AiRole, NormalizedManifest } from '~server/apps/manifest';
import { readCappedText } from '~server/http-body';
import {
  HATCH_SIGNATURE_HEADER,
  HATCH_TIMESTAMP_HEADER,
  verifyHatchSignature,
} from '~server/secrets';
import {
  chatContext,
  generateImage,
  providerErrorText,
  streamChat,
  type ChatStreamEvent,
} from '../ai/call';
import {
  AiCallError,
  aiChatRequestSchema,
  aiErrorBody,
  aiErrorResponse,
  aiImageRequestSchema,
  aiIssueMessage,
  MAX_AI_BODY_BYTES,
  type AiChatRequest,
  type AiImageRequest,
  type AiImageResult,
} from '../ai/contract';
import { resolveChatRole, resolveImageRole } from '../ai/models';
import { acquireCallSlot, recordUsage, type UsageRecord } from '../ai/usage';
import { parseAppApiPath } from './path';

const ACTIONS = { '/ai/chat': 'chat', '/ai/image': 'image' } as const;

type CallApp = {
  id: string;
  currentDeploymentId: string;
};

/**
 * App-facing AI endpoints:
 *
 *   POST /api/app/<id>/ai/chat   → SSE stream (or JSON with `stream:false`)
 *   POST /api/app/<id>/ai/image  → 200 { ok, image: { data, mimeType }, model }
 *
 * Called by the App's own backend and authenticated like notifications: an
 * HMAC over `<timestamp>.<rawBody>` with the per-app signing secret. The App
 * may only use roles its live deployment declares. The provider key never
 * leaves the platform process.
 */
export async function handleAiRequest({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const parsed = parseAppApiPath(new URL(request.url).pathname);
  const action = parsed
    ? ACTIONS[parsed.rest as keyof typeof ACTIONS]
    : undefined;
  if (!parsed || !action) return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { allow: 'POST' },
    });
  }

  // Rejects an App that cannot call AI before reading its body.
  if (!(await loadAiApp(parsed.id))) {
    return new Response('Not found', { status: 404 });
  }

  const rawBody = await readCappedText(request, MAX_AI_BODY_BYTES);
  if (rawBody === null) {
    return new Response('Payload too large', { status: 413 });
  }
  // Read the App again: a redeploy or archive while the body was arriving
  // must decide the signature, deployment and role checks below.
  const app = await loadAiApp(parsed.id);
  if (!app) return new Response('Not found', { status: 404 });
  const verified = verifyHatchSignature({
    secret: app.signingSecret,
    timestamp: request.headers.get(HATCH_TIMESTAMP_HEADER),
    signature: request.headers.get(HATCH_SIGNATURE_HEADER),
    payload: rawBody,
  });
  if (!verified) return new Response('Forbidden', { status: 403 });

  try {
    await assertSupportedDeployment(app.currentDeploymentId);
  } catch {
    return new Response('Deployment is not supported', { status: 503 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return aiErrorResponse(
      new AiCallError('ai_invalid_request', 'Body must be JSON'),
    );
  }

  const callApp: CallApp = {
    id: app.id,
    currentDeploymentId: app.currentDeploymentId,
  };
  try {
    if (action === 'chat') {
      const body = aiChatRequestSchema.safeParse(json);
      if (!body.success)
        throw new AiCallError('ai_invalid_request', aiIssueMessage(body.error));
      return await handleChat(callApp, body.data, request.signal);
    }
    const body = aiImageRequestSchema.safeParse(json);
    if (!body.success)
      throw new AiCallError('ai_invalid_request', aiIssueMessage(body.error));
    return await handleImage(callApp, body.data, request.signal);
  } catch (error) {
    if (error instanceof AiCallError) return aiErrorResponse(error);
    throw error;
  }
}

/** The App's current state, when it may call AI at all. */
async function loadAiApp(id: string) {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      id: true,
      status: true,
      currentDeploymentId: true,
      capabilities: true,
      signingSecret: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.ai ||
    !app.signingSecret
  )
    return null;
  return {
    id: app.id,
    currentDeploymentId: app.currentDeploymentId,
    signingSecret: app.signingSecret,
  };
}

/** The role as the live deployment declares it, or a stable rejection. */
async function declaredRole(
  app: CallApp,
  name: string,
  kind: AiRole['kind'],
): Promise<AiRole> {
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
    columns: { manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as NormalizedManifest | null;
  const role = manifest?.ai?.roles.find((entry) => entry.name === name);
  if (!role)
    throw new AiCallError(
      'ai_role_not_declared',
      `AI role "${name}" is not declared in the live manifest.`,
    );
  if (role.kind !== kind)
    throw new AiCallError(
      'ai_role_kind_mismatch',
      role.kind === 'chat'
        ? `AI role "${name}" is a chat role; call chat or complete with it.`
        : `AI role "${name}" is an image role; call generateImage with it.`,
    );
  return role;
}

async function record(entry: UsageRecord) {
  try {
    await recordUsage(entry);
  } catch (error) {
    console.error('[app-ai] failed to record usage', error);
  }
}

async function handleChat(
  app: CallApp,
  body: AiChatRequest,
  requestSignal: AbortSignal,
): Promise<Response> {
  const role = await declaredRole(app, body.role, 'chat');
  const { config } = await resolveChatRole(app.id, role);
  const context = chatContext(config, body);
  const release = acquireCallSlot(app.id);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  // Abort events are not replayed: a caller that left while the role, model
  // or history was being checked must not start a provider call.
  if (requestSignal.aborted) controller.abort();
  else requestSignal.addEventListener('abort', onAbort, { once: true });
  const startedAt = performance.now();
  const base = {
    appId: app.id,
    deploymentId: app.currentDeploymentId,
    role: role.name,
    kind: 'chat' as const,
    providerName: config.providerName,
    modelId: config.model.id,
  };
  const finish = async (event: ChatStreamEvent) => {
    requestSignal.removeEventListener('abort', onAbort);
    release();
    const usage =
      event.type === 'done'
        ? event.result.usage
        : event.type === 'error'
          ? event.usage
          : undefined;
    await record({
      ...base,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      cacheReadTokens: usage?.cacheReadTokens,
      cacheWriteTokens: usage?.cacheWriteTokens,
      status:
        event.type === 'done'
          ? 'ok'
          : event.type === 'error' && event.aborted
            ? 'aborted'
            : 'error',
      errorCode:
        event.type === 'error' && !event.aborted ? 'ai_provider_error' : null,
      durationMs: performance.now() - startedAt,
    });
  };

  const events = streamChat(config, body, context, controller.signal);

  if (body.stream === false) {
    let terminal: ChatStreamEvent | undefined;
    try {
      for await (const event of events) {
        if (event.type === 'done' || event.type === 'error') terminal = event;
      }
    } finally {
      await finish(
        terminal ?? {
          type: 'error',
          aborted: true,
          message: 'cancelled',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      );
    }
    if (terminal?.type === 'done') return Response.json(terminal.result);
    return aiErrorResponse(
      new AiCallError(
        'ai_provider_error',
        terminal?.type === 'error' ? terminal.message : 'The call failed.',
      ),
    );
  }

  const encoder = new TextEncoder();
  const sse = (name: string, data: unknown) =>
    encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(sink) {
      const next = await events.next();
      if (next.done) {
        sink.close();
        return;
      }
      const event = next.value;
      if (event.type === 'text') {
        sink.enqueue(sse('text', { delta: event.delta }));
      } else if (event.type === 'toolCall') {
        sink.enqueue(sse('tool_call', event.part));
      } else {
        finished = true;
        await finish(event);
        sink.enqueue(
          event.type === 'done'
            ? sse('done', event.result)
            : sse(
                'error',
                aiErrorBody(
                  'ai_provider_error',
                  event.aborted ? 'The call was cancelled.' : event.message,
                ),
              ),
        );
        sink.close();
      }
    },
    async cancel() {
      controller.abort();
      // Drain so the generator records the aborted call exactly once.
      if (!finished) {
        for await (const event of events) {
          if (event.type === 'done' || event.type === 'error') {
            finished = true;
            await finish(event);
          }
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

async function handleImage(
  app: CallApp,
  body: AiImageRequest,
  signal: AbortSignal,
): Promise<Response> {
  const role = await declaredRole(app, body.role, 'image');
  const resolved = await resolveImageRole(app.id, role);
  const release = acquireCallSlot(app.id);
  const startedAt = performance.now();
  const base = {
    appId: app.id,
    deploymentId: app.currentDeploymentId,
    role: role.name,
    kind: 'image' as const,
    providerName: resolved.providerName,
    modelId: resolved.modelId,
  };
  try {
    const png = await generateImage(
      resolved,
      body.prompt,
      body.quality ?? 'medium',
      signal,
    );
    await record({
      ...base,
      images: 1,
      status: 'ok',
      durationMs: performance.now() - startedAt,
    });
    const result: AiImageResult = {
      ok: true,
      image: { data: png.toString('base64'), mimeType: 'image/png' },
      model: { provider: resolved.providerName, id: resolved.modelId },
    };
    return Response.json(result);
  } catch (error) {
    await record({
      ...base,
      status: signal.aborted ? 'aborted' : 'error',
      errorCode: signal.aborted ? null : 'ai_provider_error',
      durationMs: performance.now() - startedAt,
    });
    throw new AiCallError(
      'ai_provider_error',
      providerErrorText(
        error instanceof Error ? error.message : 'Image generation failed.',
        resolved.provider.apiKey,
      ),
    );
  } finally {
    release();
  }
}
