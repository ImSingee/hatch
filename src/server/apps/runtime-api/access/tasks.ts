import { appAccessAllows } from '~server/apps/manifest';
import { accepted, failure, readJsonBody } from '~server/apps/tasks/http';
import {
  APP_ACTOR_PREFIX,
  getTaskRun,
  startTaskRun,
} from '~server/apps/tasks/service';
import type { AccessContext } from './index';
import { accessError, capabilityMissing, notGranted } from './errors';

/** Task run actor recorded for a run another App started. */
export function appTaskActor(appId: string): string {
  return `${APP_ACTOR_PREFIX}${appId}`;
}

/**
 * `POST /tasks/<name>/runs` starts a granted task as the calling App;
 * `GET /tasks/runs/<runId>` reads a run that App started.
 */
export async function handleTaskAccess(
  context: AccessContext,
): Promise<Response> {
  const { request, target, grant, callerId } = context;
  if (!target.capabilities.tasks) {
    return capabilityMissing(target.id, 'tasks');
  }
  const start = /^\/([^/]+)\/runs$/.exec(context.rest);
  if (start && start[1] !== 'runs' && request.method === 'POST') {
    const task = start[1];
    if (!appAccessAllows(grant, { kind: 'task', task })) {
      return notGranted(`Task ${task}`);
    }
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    try {
      return accepted(
        await startTaskRun(target.id, task, {
          trigger: 'app',
          actor: appTaskActor(callerId),
          input: body.value,
        }),
      );
    } catch (error) {
      return failure(error, `App ${callerId} → ${target.id} task ${task}`);
    }
  }
  const read = /^\/runs\/([^/]+)$/.exec(context.rest);
  if (read && request.method === 'GET') {
    const run = await getTaskRun(target.id, read[1]);
    if (
      !run ||
      run.actor !== appTaskActor(callerId) ||
      !appAccessAllows(grant, { kind: 'task', task: run.taskName })
    ) {
      return accessError(404, 'not_found', 'Task run not found.');
    }
    return Response.json(run);
  }
  return accessError(
    404,
    'not_found',
    'Use POST /tasks/<name>/runs or GET /tasks/runs/<runId>.',
  );
}
