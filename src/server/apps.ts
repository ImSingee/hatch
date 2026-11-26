import { deleteAppDatabase } from './apps/database';
import { deleteAppDataDatabase } from './apps/data-table/delete';
/** Server functions for app management (list/detail, deployments, ops, KV). */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { appCompatibility, type AppCompatibility } from '~/app-compatibility';
import { APP_SLUG_MAX_LENGTH } from '~/app-identity';
import { db } from '~/db';
// Type-only: a value import of `schema` used in exported type annotations
// would survive the client transform and drag postgres-js into the browser
// bundle (crashing the app with "Buffer is not defined").
import type { AppCapabilities, AppStatus } from '~/db/schema';
import {
  type NetworkAccessView,
  effectiveNetworkAccessView,
} from '~/network-policy';
import {
  type ExtraPermissionsView,
  extraPermissionsView,
} from '~/extra-permissions';
import { normalizedManifestFor } from './apps/access';
import {
  APP_DOC_ID_RE,
  type NormalizedManifest,
  reservedShortcuts,
  type WebhookAuth,
} from './apps/manifest';
import { readAppDoc } from './apps/docs';
import {
  type AppCronRunView,
  ensureScheduler,
  listCronJobs,
  listCronRuns,
  runCronJobNow,
} from './apps/scheduler';
import { authMiddleware, requireSession } from './auth';
import {
  builderEnabled,
  cancelDeployment as cancelBuildRequest,
  createDeployment,
  getDeployment as getBuildRequest,
  listDeployments as listBuildRequests,
  readBuildLog,
  type AppBuild,
} from './apps/builds';
import { AppError } from './errors';
import {
  idAndDeploymentSchema,
  idAndKeySchema,
  idSchema,
  nameSchema,
} from './validation';
import {
  deleteApp,
  deploymentBuildLog,
  listDeployments as loadAppDeployments,
  renameAppSlug,
  rollbackApp,
  setAppArchived,
} from './apps/manage';
import {
  listAppBackends,
  startBackendForApp,
  stopBackendForApp,
  restartBackendForApp,
} from './apps/backends';
import { listKv, setKv, deleteKv } from './apps/kv';
import {
  inspectDataTables,
  queryDataTable,
  mutateDataTable,
} from './apps/data-table/service';

export type { AppCronRunView } from './apps/scheduler';
export type { AppBackendRuntime, AppBackendView } from './apps/backends';

export type AppListItem = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppStatus;
  capabilities: AppCapabilities | null;
  createdAt: string;
  updatedAt: string;
};

export const listApps = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async (): Promise<AppListItem[]> => {
    // Opportunistically (re)start the cron scheduler on app load so schedules
    // survive a platform restart without requiring a redeploy.
    ensureScheduler();
    // Project to a safe view model: the raw row carries secrets/internal columns
    // (webhookSecret, dbName, repoPath, source commit, raw manifest) the app
    // list UI never needs and must not ship to the browser.
    const rows = await db.query.apps.findMany({
      orderBy: { updatedAt: 'desc' },
      columns: {
        id: true,
        slug: true,
        name: true,
        description: true,
        status: true,
        capabilities: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  });

export type AppDetail = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppStatus;
  capabilities: AppCapabilities | null;
  deploymentRevision: string | null;
  compatibility: AppCompatibility | null;
  /** Chords the live deployment handles itself; see `keyboard.reserve`. */
  reservedShortcuts: string[];
  currentSourceCommit: string | null;
  dbName: string | null;
  createdAt: string;
  updatedAt: string;
};

export const getAppBySlug = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((slug: string) =>
    z.string().min(1).max(APP_SLUG_MAX_LENGTH).parse(slug),
  )
  .handler(async ({ data: slug }): Promise<AppDetail | null> => {
    // Project to a display view: the raw row carries secrets/internal columns
    // (webhookSecret, repoPath, raw manifest) the app detail/manage pages never
    // need and must not ship to the browser. The live deployment id is exposed
    // only under the safe `deploymentRevision` view-model name.
    const columns = {
      id: true,
      slug: true,
      name: true,
      description: true,
      status: true,
      capabilities: true,
      currentDeploymentId: true,
      currentSourceCommit: true,
      dbName: true,
      createdAt: true,
      updatedAt: true,
    } as const;
    const row = await db.query.apps.findFirst({
      where: { slug },
      columns,
    });
    if (!row) return null;
    const { currentDeploymentId, ...detail } = row;
    const deployment = currentDeploymentId
      ? await db.query.deployments.findFirst({
          where: { id: currentDeploymentId },
          columns: { compatibilityVersion: true, manifestNormalized: true },
        })
      : null;
    return {
      ...detail,
      deploymentRevision: currentDeploymentId,
      compatibility: deployment
        ? appCompatibility(deployment.compatibilityVersion)
        : null,
      reservedShortcuts: reservedShortcuts(
        deployment?.manifestNormalized as NormalizedManifest | null,
      ),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

/** Read the authoritative live revision without reloading the full App view. */
export const getAppDeploymentRevision = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<string | null> => {
    const app = await db.query.apps.findFirst({
      where: { id },
      columns: { currentDeploymentId: true },
    });
    return app?.currentDeploymentId ?? null;
  });

export type AppRow = NonNullable<Awaited<ReturnType<typeof getAppBySlug>>>;

export const getNormalizedManifest = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => normalizedManifestFor(id));

/** One external doc body of the current deployment, for the manage page. */
export const getAppDocFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; docId: string }) =>
    z
      .object({ id: idSchema, docId: z.string().regex(APP_DOC_ID_RE) })
      .parse(input),
  )
  .handler(async ({ data }) => readAppDoc(data.id, data.docId));

export const listDeployments = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    return loadAppDeployments(id);
  });

export const getDeploymentBuildLog = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) =>
    idAndDeploymentSchema.parse(input),
  )
  .handler(async ({ data }) => {
    return deploymentBuildLog(data.id, data.deploymentId);
  });

const ACTIVE_DEPLOYMENT_STATUSES: readonly string[] = [
  'queued',
  'awaiting_artifact',
  'building',
  'verifying',
  'releasing',
];

/**
 * A deployment request as the manage page shows it. Module-level code stays
 * in the client bundle, so it uses no server value import.
 */
function deploymentRequestView(row: AppBuild) {
  return {
    id: row.id,
    seq: row.seq,
    commit: row.commit,
    message: row.message,
    build: row.mode,
    trigger: row.trigger,
    status: row.status,
    finished: !ACTIVE_DEPLOYMENT_STATUSES.includes(row.status),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    version: row.deploymentVersion,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
export type AppDeploymentRequestView = ReturnType<typeof deploymentRequestView>;

/** Recent deployment requests and whether the platform has a Builder. */
export const listAppDeploymentRequestsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    const page = await listBuildRequests(id, { limit: 10 });
    return {
      builderEnabled: builderEnabled(),
      deployments: page.items.map(deploymentRequestView),
    };
  });

/** A deployment's log lines after `afterSeq`, and its current state. */
export const getAppDeploymentLogFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string; afterSeq: number }) =>
    z
      .object({
        id: idSchema,
        deploymentId: z.string().min(1).max(64),
        afterSeq: z.number().int().min(0),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const row = await getBuildRequest(data.id, data.deploymentId);
    const lines = await readBuildLog(row.id, data.afterSeq, 2000);
    return {
      deployment: deploymentRequestView(row),
      lines: lines.map((line) => ({
        seq: line.seq,
        stream: line.stream,
        text: line.text,
      })),
    };
  });

export const cancelAppDeploymentFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) =>
    z
      .object({ id: idSchema, deploymentId: z.string().min(1).max(64) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return deploymentRequestView(
      await cancelBuildRequest(data.id, data.deploymentId, session.user.id),
    );
  });

/** Build a recorded commit again on the Builder and release it. */
export const redeployAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; commit: string; message: string }) =>
    z
      .object({
        id: idSchema,
        commit: z.string().regex(/^[0-9a-f]{40}$/),
        message: z.string().trim().min(1).max(1000),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const session = await requireSession();
    return deploymentRequestView(
      await createDeployment({
        appId: data.id,
        commit: data.commit,
        message: data.message,
        build: 'builder',
        trigger: 'ui',
        actor: session.user.id,
        notify: true,
      }),
    );
  });

export const rollbackAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; deploymentId: string }) =>
    idAndDeploymentSchema.parse(input),
  )
  .handler(async ({ data }) => {
    return rollbackApp(data.id, data.deploymentId);
  });

export const archiveAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; archived: boolean }) =>
    z.object({ id: idSchema, archived: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    return setAppArchived(data.id, data.archived);
  });

export const deleteAppFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    return deleteApp(id);
  });

export const deleteAppDatabaseFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; dbName: string; appName: string }) =>
    z
      .object({
        id: idSchema,
        dbName: z.string().min(1),
        appName: z.string().min(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    return deleteAppDatabase(data.id, data.dbName, data.appName);
  });

export const deleteAppDataDatabaseFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; dbName: string; appName: string }) =>
    z
      .object({
        id: idSchema,
        dbName: z.string().min(1),
        appName: z.string().min(1),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    return deleteAppDataDatabase(data.id, data.dbName, data.appName);
  });

export const setAppSlugFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; slug: string }) =>
    z
      .object({
        id: idSchema,
        slug: z.string().max(APP_SLUG_MAX_LENGTH),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    return renameAppSlug(data.id, data.slug);
  });

/** ================== capabilities (cron / webhook / backend) ================== */

export type CronJobView = {
  name: string;
  schedule: string;
  method: string | null;
  path: string | null;
  nextRun: string | null;
};

export type AppKvEntryView = {
  key: string;
  /** Plaintext value, or null when secret (hidden from the UI; overwrite-only). */
  value: string | null;
  secret: boolean;
  updatedAt: string;
};

export type AppOps = {
  backend: {
    capable: boolean;
    mode: 'serverless' | 'long-running' | null;
    /** Declaration from the active deployment; null before first deployment. */
    network: NetworkAccessView | null;
    extraPermissions: ExtraPermissionsView | null;
  };
  database: { enabled: boolean; dbName: string | null };
  cron: { enabled: boolean; jobs: CronJobView[] };
  webhook: {
    enabled: boolean;
    url: string | null;
    /** Present only in 'platform' auth mode (the verified shared secret). */
    secret: string | null;
    /** Platform-side auth mode: 'platform' (secret + HMAC) or 'none'. */
    auth: WebhookAuth;
  };
  storage: { enabled: boolean };
  /** KV entries are fetched separately (they mutate live); this just gates the UI. */
  kv: { enabled: boolean };
  dataTable: {
    enabled: boolean;
    dbName: string | null;
    schemaHash: string | null;
  };
};

export const getAppOps = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppOps> => {
    const app = await db.query.apps.findFirst({
      where: { id },
    });
    if (!app) {
      return {
        backend: {
          capable: false,
          mode: null,
          network: null,
          extraPermissions: null,
        },
        database: { enabled: false, dbName: null },
        cron: { enabled: false, jobs: [] },
        webhook: { enabled: false, url: null, secret: null, auth: 'platform' },
        storage: { enabled: false },
        kv: { enabled: false },
        dataTable: { enabled: false, dbName: null, schemaHash: null },
      };
    }
    const caps = app.capabilities;
    const manifest: NormalizedManifest | null = await normalizedManifestFor(id);

    const cronJobs = caps?.cron ? await listCronJobs(id) : [];
    return {
      backend: {
        capable: Boolean(caps?.backend),
        mode: app.backendMode ?? null,
        extraPermissions: manifest?.backend
          ? extraPermissionsView(manifest.backend.extraPermissions)
          : null,
        network: manifest?.backend
          ? effectiveNetworkAccessView(
              manifest.backend.network,
              manifest.backend.extraPermissions,
            )
          : null,
      },
      database: {
        enabled: Boolean(caps?.database),
        dbName: app.dbName ?? null,
      },
      cron: { enabled: Boolean(caps?.cron), jobs: cronJobs },
      webhook: {
        enabled: Boolean(caps?.webhook),
        url: manifest?.webhook?.url ?? null,
        // Only surface the secret in platform-auth mode. A secret may still be
        // persisted on the row (kept for rollback safety) while the live mode is
        // 'none', but it is meaningless there, so don't leak it to the browser.
        secret:
          (manifest?.webhook?.auth ?? 'platform') === 'platform'
            ? (app.webhookSecret ?? null)
            : null,
        auth: manifest?.webhook?.auth ?? 'platform',
      },
      storage: { enabled: Boolean(caps?.storage) },
      kv: { enabled: Boolean(caps?.kv) },
      dataTable: {
        enabled: Boolean(caps?.dataTable),
        dbName: app.dataDbName ?? null,
        schemaHash: app.dataSchemaHash ?? null,
      },
    };
  });

/** ================== backends page (list + start/stop/restart) ========= */

export const listAppBackendsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .handler(async () => {
    return listAppBackends();
  });

export const startAppBackendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    return startBackendForApp(id);
  });

export const stopAppBackendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; force?: boolean }) =>
    z.object({ id: idSchema, force: z.boolean().optional() }).parse(input),
  )
  .handler(async ({ data }) => {
    return stopBackendForApp(data.id, { force: data.force });
  });

export const restartAppBackendFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    return restartBackendForApp(id);
  });

export const runCronJobFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; name: string }) =>
    z.object({ id: idSchema, name: nameSchema }).parse(input),
  )
  .handler(async ({ data }) => {
    return runCronJobNow(data.id, data.name);
  });

export const listCronRunsFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppCronRunView[]> => {
    return listCronRuns(id);
  });

/** ================== app KV (manage UI) ================== */

/**
 * Guard for the KV management server fns. These are plain authenticated RPCs, so
 * the UI only rendering the KV panel for kv-capable apps is not a real boundary —
 * a crafted call could otherwise read/write `app_kv` for an arbitrary id. Re-check
 * here that the target app exists, isn't archived, and actually has the `kv`
 * capability before touching the table. (Single-tenant: a valid session is the
 * owner, so this is existence/capability gating, not cross-user authorization.)
 */
async function requireKvApp(id: string): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { status: true, capabilities: true },
  });
  if (!app || app.status === 'archived' || !app.capabilities?.kv) {
    throw new AppError('App not found', 404, { code: 'ops.appNotFound' });
  }
}

export const listAppKvFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }): Promise<AppKvEntryView[]> => {
    await requireKvApp(id);
    const records = await listKv(id, { revealSecrets: false });
    // Mask secret values: the manage UI may overwrite them but never read them.
    return records.map((r) => ({
      key: r.key,
      value: r.secret ? null : r.value,
      secret: r.secret,
      updatedAt: r.updatedAt,
    }));
  });

export const setAppKvFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator(
    (input: { id: string; key: string; value: string; secret?: boolean }) =>
      // Key/value length limits live in the KV module (KvError with proper
      // messages); this only guards shape and types.
      z
        .object({
          id: idSchema,
          key: z.string(),
          value: z.string(),
          secret: z.boolean().optional(),
        })
        .parse(input),
  )
  .handler(async ({ data }) => {
    await requireKvApp(data.id);
    const rec = await setKv(data.id, data.key, data.value, {
      secret: data.secret,
    });
    return { ok: true, secret: rec.secret };
  });

export const deleteAppKvFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; key: string }) =>
    idAndKeySchema.parse(input),
  )
  .handler(async ({ data }) => {
    await requireKvApp(data.id);
    return { ok: await deleteKv(data.id, data.key) };
  });

/** ================== managed Data Tables (manage UI) ================== */

async function requireDataTableApp(id: string): Promise<void> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      status: true,
      capabilities: true,
      currentDeploymentId: true,
      dataActivationId: true,
    },
  });
  if (
    !app ||
    app.status === 'archived' ||
    !app.currentDeploymentId ||
    !app.capabilities?.dataTable
  ) {
    throw new AppError('App not found', 404, { code: 'ops.appNotFound' });
  }
  if (app.dataActivationId) {
    throw new AppError('Data Table deployment is being finalized.', 503, {
      code: 'ops.dataTable.finalizing',
    });
  }
}

export const inspectAppDataTablesFn = createServerFn({ method: 'GET' })
  .middleware([authMiddleware])
  .validator((id: string) => idSchema.parse(id))
  .handler(async ({ data: id }) => {
    await requireDataTableApp(id);
    return inspectDataTables(id);
  });

export const queryAppDataTableFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; query: unknown }) =>
    z.object({ id: idSchema, query: z.unknown() }).parse(input),
  )
  .handler(async ({ data }) => {
    await requireDataTableApp(data.id);
    return queryDataTable(data.id, data.query);
  });

export const mutateAppDataTableFn = createServerFn({ method: 'POST' })
  .middleware([authMiddleware])
  .validator((input: { id: string; mutation: unknown }) =>
    z.object({ id: idSchema, mutation: z.unknown() }).parse(input),
  )
  .handler(async ({ data }) => {
    await requireDataTableApp(data.id);
    return mutateDataTable(data.id, data.mutation);
  });
