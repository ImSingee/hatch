/**
 * `appAccess`: what this App's backend may reach in other Apps through the
 * platform relay (`/api/app/<id>/access/<target>/...`). Every grant names its
 * items explicitly; an omitted list grants nothing.
 */
import { z } from 'zod';
import {
  APP_ID_RE,
  APP_TASK_NAME_MAX_LENGTH,
  APP_TASK_NAME_RE,
  DATA_NAME_RE,
  RPC_METHOD_PATH_RE,
  RPC_SERVICE_NAME_RE,
  isValidAppSlug,
} from './identifiers.js';

/** `*`, `package.Service/*` or `package.Service/Method`. */
const rpcGrantSchema = z
  .string()
  .refine(
    (value) =>
      value === '*' ||
      RPC_METHOD_PATH_RE.test(value) ||
      (value.endsWith('/*') && RPC_SERVICE_NAME_RE.test(value.slice(0, -2))),
    {
      message:
        'must be "*", "package.Service/*" or "package.Service/Method" using Protobuf identifiers',
    },
  );

const tableNameSchema = z
  .string()
  .max(63)
  .regex(DATA_NAME_RE, 'must be a Data Table name');

const taskNameSchema = z
  .string()
  .max(APP_TASK_NAME_MAX_LENGTH)
  .regex(APP_TASK_NAME_RE, 'must be a task name');

const WEBHOOK_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

/** True for `/`, or `/`-separated plain segments with no dot segments. */
export function isCanonicalWebhookPath(path: string): boolean {
  if (path === '/') return true;
  if (!path.startsWith('/')) return false;
  return path
    .slice(1)
    .split('/')
    .every(
      (segment) =>
        WEBHOOK_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..',
    );
}

/** `*`, an exact path (`/ingest`) or a path and everything below (`/media/*`). */
const webhookGrantSchema = z.string().refine(
  (value) => {
    if (value === '*') return true;
    if (value.endsWith('/*')) {
      const base = value.slice(0, -2);
      return base === '' || isCanonicalWebhookPath(base);
    }
    return isCanonicalWebhookPath(value);
  },
  {
    message:
      'must be "*", an absolute path such as "/ingest", or a prefix such as "/media/*" (plain segments, no "..", query or encoded bytes)',
  },
);

function uniqueList<T extends z.ZodType<string>>(item: T) {
  return z
    .array(item)
    .default([])
    .refine((items) => new Set(items).size === items.length, {
      message: 'must not list the same entry twice',
    });
}

export const appAccessGrantSchema = z
  .object({
    /** Immutable id of the target App (from `hatch app list --json`). */
    app: z.string().min(1).regex(APP_ID_RE, 'must be an App id'),
    /** Optional name the backend code uses instead of the id. */
    alias: z
      .string()
      .refine(isValidAppSlug, {
        message:
          'alias must be at most 64 lowercase letters, digits, and hyphens, starting with a letter or digit',
      })
      .optional(),
    rpc: uniqueList(rpcGrantSchema),
    dataTables: z
      .object({
        read: uniqueList(tableNameSchema),
        /** Writing a table includes reading it. */
        write: uniqueList(tableNameSchema),
      })
      .strict()
      .default({ read: [], write: [] }),
    tasks: uniqueList(taskNameSchema),
    webhook: uniqueList(webhookGrantSchema),
  })
  .strict()
  .refine(
    (grant) =>
      grant.rpc.length +
        grant.dataTables.read.length +
        grant.dataTables.write.length +
        grant.tasks.length +
        grant.webhook.length >
      0,
    {
      message:
        'grant at least one of rpc, dataTables.read, dataTables.write, tasks or webhook',
    },
  );

export const appAccessSchema = z
  .array(appAccessGrantSchema)
  .superRefine((grants, ctx) => {
    const apps = new Set<string>();
    const aliases = new Set<string>();
    grants.forEach((grant, index) => {
      if (apps.has(grant.app)) {
        ctx.addIssue({
          code: 'custom',
          message: 'the same App is listed twice; merge its grants',
          path: [index, 'app'],
        });
      }
      apps.add(grant.app);
      if (grant.alias === undefined) return;
      if (aliases.has(grant.alias)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicate alias',
          path: [index, 'alias'],
        });
      }
      aliases.add(grant.alias);
    });
    grants.forEach((grant, index) => {
      if (grant.alias !== undefined && apps.has(grant.alias)) {
        ctx.addIssue({
          code: 'custom',
          message: 'alias must not equal another listed App id',
          path: [index, 'alias'],
        });
      }
    });
  });

export type AppAccessGrant = z.infer<typeof appAccessGrantSchema>;

/** One relayed operation the platform authorizes against a grant. */
export type AppAccessRequest =
  | { kind: 'rpc'; method: string }
  | { kind: 'data'; table: string; access: 'read' | 'write' }
  | { kind: 'task'; task: string }
  | { kind: 'webhook'; path: string };

/** The grant a relay `<target>` (an App id or alias) refers to. */
export function findAppAccessGrant(
  grants: readonly AppAccessGrant[] | undefined,
  target: string,
): AppAccessGrant | undefined {
  if (!grants) return undefined;
  return (
    grants.find((grant) => grant.app === target) ??
    grants.find((grant) => grant.alias === target)
  );
}

function webhookGrantMatches(grant: string, path: string): boolean {
  if (grant === '*') return true;
  if (grant.endsWith('/*')) {
    const base = grant.slice(0, -2);
    return base === '' || path === base || path.startsWith(`${base}/`);
  }
  return path === grant;
}

/** Whether `grant` covers `request`. Callers validate request syntax first. */
export function appAccessAllows(
  grant: AppAccessGrant,
  request: AppAccessRequest,
): boolean {
  switch (request.kind) {
    case 'rpc': {
      const service = request.method.slice(0, request.method.indexOf('/'));
      return grant.rpc.some(
        (entry) =>
          entry === '*' || entry === request.method || entry === `${service}/*`,
      );
    }
    case 'data':
      return (
        grant.dataTables.write.includes(request.table) ||
        (request.access === 'read' &&
          grant.dataTables.read.includes(request.table))
      );
    case 'task':
      return grant.tasks.includes(request.task);
    case 'webhook':
      return grant.webhook.some((entry) =>
        webhookGrantMatches(entry, request.path),
      );
  }
}
