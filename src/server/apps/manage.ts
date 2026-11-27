/** Server-only: app lifecycle management — archive, rollback, delete. */
import { removeAppIconFiles } from './icon';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { appNativePackagesDir, signActivatedPackage } from './native/packages';
import {
  appCompatibility,
  appCompatibilityRollbackMessage,
  type AppCompatibility,
} from '~/app-compatibility';
import {
  deploymentBuildDir,
  appBuildDir,
  appSrcDir,
  appStorageDir,
  appVersionsDir,
  appArtifactsDir,
  appRepoDir,
  deploymentArtifactDir,
} from '~agent/paths';
import { db, schema } from '~/db';
import {
  APP_NAME_MAX_LENGTH,
  APP_SLUG_MAX_LENGTH,
  isAppNameWithinMaxLength,
} from '~/app-identity';
import { publishPlatformEvent } from '~server/platform-events';
import { syncAppNotificationDestination } from '~server/notifications/app-destinations';
import { AppError } from '~server/errors';
import { buildMatchesDeployment } from './build-identity';
import { appDeployLock } from './deploy';
import { appCommitOnMaster, moveMasterToDeploymentTag } from './git';
import {
  type NormalizedManifest,
  isValidAppId,
  isValidAppSlug,
} from './manifest';
import { dropAppDatabase, withAppDatabaseLifecycle } from './provision';
import {
  type RollbackBlockedCode,
  deploymentRollbackBlockedCode,
  deploymentRequiresDatabase,
  rollbackBlockedReason,
} from './rollback-policy';
import {
  dropAppDataDatabase,
  withAppDataCutoverLock,
} from './data-table/provision';
import {
  recoverCurrentDataSchema,
  waitForDataMigrationBarrier,
} from './data-table/migrate';
import { closeDataRealtime } from './data-table/realtime';
import { ensureAppRunning, killApp, setKeepAlive, stopApp } from './runtime';
import { reloadScheduler } from './scheduler';
import { appSlugExists } from './access';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function appNotFound(id: string) {
  return new AppError(`App "${id}" not found.`, 404, {
    code: 'app.notFoundWithId',
    params: { id },
  });
}

function rollbackBlockedError(version: number, blocked: RollbackBlockedCode) {
  return new AppError(
    `Cannot restore v${version}. ${rollbackBlockedReason(blocked)}`,
    409,
    { code: `deployment.rollbackBlocked.${blocked}`, params: { version } },
  );
}

export type DeploymentSummary = {
  id: string;
  version: number;
  status: schema.DeploymentStatus;
  message: string | null;
  error: string | null;
  createdAt: string;
  isCurrent: boolean;
  canRollback: boolean;
  rollbackBlockedReason: string | null;
  /** Stable form of `rollbackBlockedReason` for the Web UI to translate. */
  rollbackBlockedCode: RollbackBlockedCode | null;
  /** Commit on the app's `master` branch this version was built from. */
  sourceCommit: string | null;
  /**
   * Whether that commit is still on master, so the version can be built
   * again (a restore moves master back past newer versions). `null` when the
   * lookup failed: unknown, so a client keeps offering the rebuild and the
   * platform still refuses a commit that is not on master.
   */
  sourceOnMaster: boolean | null;
  /** Immutable `deploy/v<version>` Git tag for this version. */
  sourceTag: string | null;
  /** Whether the build artifact still exists on disk (required to restore). */
  hasArtifact: boolean;
  /** Whether a build log exists; the log itself is fetched lazily on expand. */
  hasBuildLog: boolean;
  /** True when rolling back code would keep a newer/different Data Table schema. */
  dataSchemaMismatch: boolean;
  compatibility: AppCompatibility;
};

export type AppRollbackResult = {
  version: number;
  dataSchemaMismatch: boolean;
  compatibility: AppCompatibility;
};

/** Git lookups `commitsOnMaster` runs at once, whatever the history length. */
const ON_MASTER_LOOKUPS = 4;

/**
 * Whether each distinct commit is on master; a commit whose lookup failed
 * maps to null (unknown) instead of reading as "not on master".
 */
async function commitsOnMaster(
  appId: string,
  commits: readonly string[],
): Promise<Map<string, boolean | null>> {
  const pending = [...new Set(commits)];
  const result = new Map<string, boolean | null>();
  const worker = async () => {
    for (let commit = pending.pop(); commit; commit = pending.pop()) {
      result.set(
        commit,
        await appCommitOnMaster(appId, commit).catch((error) => {
          console.error(
            `[apps] could not tell whether ${commit} of ${appId} is on master:`,
            error,
          );
          return null;
        }),
      );
    }
  };
  await Promise.all(Array.from({ length: ON_MASTER_LOOKUPS }, worker));
  return result;
}

/** List an app's deployment history, newest first, with rollback hints. */
export async function listDeployments(
  id: string,
): Promise<DeploymentSummary[]> {
  const app = await db.query.apps.findFirst({
    where: { id },
  });
  const rows = await db.query.deployments.findMany({
    where: { appId: id },
    orderBy: { version: 'desc' },
  });
  const liveDataSchemaHash = app?.dataSchemaHash ?? null;
  const dataActivationPending = Boolean(
    app?.dataActivationId &&
    (app.dataDbName || app.dataSchemaHash || app.capabilities?.dataTable),
  );
  const current = app?.currentDeploymentId ?? null;
  const onMaster = await commitsOnMaster(
    id,
    rows.flatMap((d) => (d.sourceCommit ? [d.sourceCommit] : [])),
  );
  return Promise.all(
    rows.map(async (d) => {
      const isCurrent = d.id === current;
      const hasArtifact =
        (d.artifactPath
          ? await pathExists(deploymentArtifactDir(id, d.id))
          : false) || (await pathExists(deploymentBuildDir(id, d.id)));
      const baseCanRollback =
        !isCurrent &&
        d.status === 'deployed' &&
        Boolean(d.sourceTag) &&
        hasArtifact;
      const rollbackBlockedCode = baseCanRollback
        ? deploymentRollbackBlockedCode(
            {
              dbName: app?.dbName ?? null,
              dataDbName: app?.dataDbName ?? null,
              dataDbPasswordCiphertext: app?.dataDbPasswordCiphertext ?? null,
            },
            d.manifestNormalized,
          )
        : null;
      return {
        id: d.id,
        version: d.version,
        status: d.status,
        message: d.message,
        error: d.error,
        createdAt: d.createdAt.toISOString(),
        isCurrent,
        sourceCommit: d.sourceCommit,
        sourceOnMaster: d.sourceCommit
          ? (onMaster.get(d.sourceCommit) ?? null)
          : false,
        sourceTag: d.sourceTag,
        hasArtifact,
        hasBuildLog: Boolean(d.buildLog),
        rollbackBlockedReason: rollbackBlockedReason(rollbackBlockedCode),
        rollbackBlockedCode,
        dataSchemaMismatch:
          (dataActivationPending && !isCurrent) ||
          (Boolean(d.dataSchemaHash || liveDataSchemaHash) &&
            (d.dataSchemaHash ?? null) !== liveDataSchemaHash),
        compatibility: appCompatibility(d.compatibilityVersion),
        canRollback: baseCanRollback && !rollbackBlockedCode,
      };
    }),
  );
}

/**
 * Fetch a single deployment's build log on demand. Kept out of the
 * {@link listDeployments} payload so opening the management page doesn't ship
 * every (potentially large) build log up front — the UI fetches this only when
 * a row's log is expanded.
 */
export async function deploymentBuildLog(
  appId: string,
  deploymentId: string,
): Promise<string | null> {
  const d = await db.query.deployments.findFirst({
    where: { appId, id: deploymentId },
  });
  return d?.buildLog ?? null;
}

/** Archive (or unarchive) an app. Archiving stops its backend. */
export function setAppArchived(
  id: string,
  archived: boolean,
): Promise<{ status: schema.AppStatus }> {
  // Match deploy/rollback/delete lock ordering. An archive requested during a
  // build queues behind that release and is then the deterministic last writer
  // instead of being overwritten by the release transaction.
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () => setAppArchivedInner(id, archived)),
  );
}

async function setAppArchivedInner(
  id: string,
  archived: boolean,
): Promise<{ status: schema.AppStatus }> {
  const app = await db.query.apps.findFirst({
    where: { id },
  });
  if (!app) throw appNotFound(id);

  const status: schema.AppStatus = archived
    ? 'archived'
    : app.currentDeploymentId
      ? 'deployed'
      : 'draft';

  await db.update(schema.apps).set({ status }).where(eq(schema.apps.id, id));

  if (archived) {
    killApp(id);
    if (app.dataDbName || app.dataActivationId || app.capabilities?.dataTable) {
      await closeDataRealtime(id);
      // A Data request may already hold the shared migration lock after checking
      // the previous live status. Drain it before reporting archive complete, so
      // no mutation can commit after the user sees the App as archived.
      if (app.dataDbPasswordCiphertext) {
        await waitForDataMigrationBarrier(id);
      }
    }
  }
  // Archived apps must not keep firing cron; restored ones resume.
  await reloadScheduler();
  return { status };
}

/**
 * Change an app's mutable URL slug. The slug appears in the human-facing
 * `/app/<slug>` URL, so this is a cheap rename: no rebuild and no FK churn
 * (technical APIs and storage are keyed off the immutable `id`). Enforces shape
 * and uniqueness; the unique index on `slug` is the final backstop against
 * races.
 */
export async function renameAppSlug(
  id: string,
  rawSlug: string,
): Promise<{ slug: string }> {
  const slug = rawSlug.trim();
  if (slug.length > APP_SLUG_MAX_LENGTH) {
    throw new AppError(
      `Slug must be at most ${APP_SLUG_MAX_LENGTH} characters.`,
      400,
      { code: 'app.slug.tooLong', params: { max: APP_SLUG_MAX_LENGTH } },
    );
  }
  if (!isValidAppSlug(slug)) {
    throw new AppError(
      'Slug must be kebab-case (lowercase letters, digits, and hyphens, ' +
        'starting with a letter or digit).',
      400,
      { code: 'app.slug.invalid' },
    );
  }

  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { id: true, slug: true },
  });
  if (!app) throw appNotFound(id);
  if (app.slug === slug) return { slug };

  // Slugs are unique only within the human-facing URL namespace. App ids are
  // addressed independently at every technical boundary.
  if (await appSlugExists(slug, id)) {
    throw new AppError(`Slug "${slug}" is already in use.`, 409, {
      code: 'app.slug.taken',
      params: { slug },
    });
  }

  await db.update(schema.apps).set({ slug }).where(eq(schema.apps.id, id));
  return { slug };
}

/**
 * Roll an app back to a previous deployment by restoring its build snapshot
 * and re-pointing the live build dir + current deployment. Serving reads the
 * normalized manifest from the current deployment, so URLs follow automatically.
 * Serialized with deploys via the shared per-app lock so a rollback and a
 * deploy can't interleave their artifact/Git/row mutations and leave the DB
 * pointing at one version while the live dir/`master` points at another.
 */
export function rollbackApp(
  id: string,
  deploymentId: string,
): Promise<AppRollbackResult> {
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () =>
      rollbackAppInner(id, deploymentId, {
        allowUnsupportedCompatibility: false,
      }),
    ),
  );
}

async function rollbackAppInner(
  id: string,
  deploymentId: string,
  options: { allowUnsupportedCompatibility: boolean },
): Promise<AppRollbackResult> {
  const app = await db.query.apps.findFirst({
    where: { id },
  });
  if (!app) throw appNotFound(id);

  const deployment = await db.query.deployments.findFirst({
    where: { id: deploymentId },
  });
  if (!deployment || deployment.appId !== id) {
    throw new AppError('Deployment not found for this app.', 404, {
      code: 'deployment.notFound',
    });
  }
  const compatibility = appCompatibility(deployment.compatibilityVersion);
  if (!compatibility.isSupported && !options.allowUnsupportedCompatibility) {
    throw new AppError(
      appCompatibilityRollbackMessage(compatibility),
      409,
      compatibility.version > compatibility.latestVersion
        ? {
            code: 'deployment.rollbackNeedsNewerPlatform',
            params: {
              version: compatibility.version,
              latest: compatibility.latestVersion,
            },
          }
        : { code: 'deployment.rollbackBelowMinimum' },
    );
  }
  if (deployment.status !== 'deployed') {
    throw new AppError('Only successful deployments can be restored.', 409, {
      code: 'deployment.notSuccessful',
    });
  }
  const versionParams = { params: { version: deployment.version } };

  const artifact = deploymentArtifactDir(id, deploymentId);
  const legacySnapshot = deploymentBuildDir(id, deploymentId);
  const snapshot = (await pathExists(artifact)) ? artifact : legacySnapshot;
  if (!(await pathExists(snapshot))) {
    throw new AppError(
      `No artifact exists for v${deployment.version}. ` +
        'Only deployments built with artifact support can be restored.',
      409,
      { code: 'deployment.noArtifact', ...versionParams },
    );
  }
  if (!(await buildMatchesDeployment(id, deploymentId, snapshot))) {
    throw new AppError(
      `The artifact for v${deployment.version} does not match its deployment.`,
      409,
      { code: 'deployment.artifactMismatch', ...versionParams },
    );
  }
  if (!deployment.sourceTag) {
    throw new AppError(
      `Deployment v${deployment.version} has no source tag and cannot ` +
        'restore source. Run the app Git migration first.',
      409,
      { code: 'deployment.noSourceTag', ...versionParams },
    );
  }
  const sourceTag = deployment.sourceTag;
  const manifest = deployment.manifestNormalized as NormalizedManifest | null;
  const requiresDatabase = deploymentRequiresDatabase(manifest);
  const initiallyBlocked = deploymentRollbackBlockedCode(app, manifest);
  if (initiallyBlocked) {
    throw rollbackBlockedError(deployment.version, initiallyBlocked);
  }
  const restoredName = manifest?.name ?? app.name;
  if (!isAppNameWithinMaxLength(restoredName)) {
    throw new AppError(
      `Deployment v${deployment.version} cannot be restored because its App ` +
        `name exceeds ${APP_NAME_MAX_LENGTH} characters.`,
      409,
      {
        code: 'deployment.nameTooLong',
        params: { version: deployment.version, max: APP_NAME_MAX_LENGTH },
      },
    );
  }
  let latestDataSchemaHash = app.dataSchemaHash ?? null;
  // A pending activation may represent a migration whose COMMIT acknowledgement
  // was lost. Clear that fence only after taking the migration barrier and
  // reading the committed schema authoritatively. Code rollback stays available
  // when the Data DB is down, but Data access remains fenced until recovery.
  let dataMigrationResolved = !app.dataActivationId;
  if (app.dataDbName || app.dataActivationId) {
    try {
      latestDataSchemaHash = (await recoverCurrentDataSchema(id))?.hash ?? null;
      dataMigrationResolved = true;
    } catch {
      // Retain the last known hash. If an activation is pending, retaining its
      // fence is what prevents an unconfirmed schema from reaching restored code.
    }
  }
  const pendingActivationBackup =
    dataMigrationResolved && app.dataActivationId
      ? `${appBuildDir(id)}.bak-${app.dataActivationId}`
      : null;

  // Mutate the live build dir, Git master, and the app row under the same
  // advisory lock deploy holds for its version→tag→record step, so a concurrent
  // deploy on another process blocks until we finish (and vice versa).
  let previousDeploymentId = app.currentDeploymentId ?? null;
  const performCutover = () =>
    db.transaction(async (tx) => {
      await appDeployLock.acquire(tx, id);
      const current = await tx.query.apps.findFirst({
        where: { id },
        columns: {
          currentDeploymentId: true,
          dbName: true,
          dataDbName: true,
          dataDbPasswordCiphertext: true,
        },
      });
      if (!current) throw appNotFound(id);
      const blocked = deploymentRollbackBlockedCode(current, manifest);
      if (blocked) throw rollbackBlockedError(deployment.version, blocked);
      previousDeploymentId = current.currentDeploymentId ?? null;
      const live = appBuildDir(id);
      await fs.rm(live, { recursive: true, force: true });
      await fs.mkdir(live, { recursive: true });
      // Legacy artifacts predate the immutable deployment marker. Always stamp
      // the live copy before changing the platform pointer so another worker can
      // distinguish rollback bytes from the still-current deployment while this
      // transaction is in flight.
      await fs.writeFile(
        path.join(live, 'deployment.json'),
        JSON.stringify({ deploymentId: deployment.id }, null, 2),
        'utf8',
      );
      await fs.cp(snapshot, live, { recursive: true });
      const sourceCommit = await moveMasterToDeploymentTag(id, sourceTag);
      if (pendingActivationBackup) {
        // The activation id is the durable key used to find this recovery state.
        // Remove the backup before the transaction clears that key so a crash can
        // never leave a snapshot that no later lifecycle operation can identify.
        await fs.rm(pendingActivationBackup, { recursive: true, force: true });
      }

      await tx
        .update(schema.apps)
        .set({
          status: 'deployed',
          currentDeploymentId: deployment.id,
          // The build number of a native package; see native/packages.ts.
          activationSeq: sql`${schema.apps.activationSeq} + 1`,
          currentSourceCommit: sourceCommit,
          name: restoredName,
          // Restore the rolled-back version's full metadata too. Otherwise the row
          // keeps the newer deployment's capabilities/backendMode/description — e.g.
          // the cron scheduler reads app.capabilities.cron and would skip jobs the
          // restored version actually defines (mirrors what the deploy path writes).
          description: manifest?.description || null,
          capabilities: manifest?.capabilities ?? app.capabilities,
          backendMode: manifest?.backendMode ?? app.backendMode,
          manifest: deployment.manifestNormalized ?? app.manifest,
          dataSchemaHash: latestDataSchemaHash,
          // Rollback is an explicit user-selected cutover. It may intentionally
          // restore code whose forward-only Data schema differs. Clear a failed
          // deployment's fence only after its migration outcome was resolved.
          dataActivationId: dataMigrationResolved ? null : app.dataActivationId,
        })
        .where(eq(schema.apps.id, id));
      await syncAppNotificationDestination(tx, id, restoredName, manifest);
    });

  if (requiresDatabase) {
    await withAppDatabaseLifecycle(id, performCutover);
  } else {
    await performCutover();
  }

  if (previousDeploymentId !== deployment.id) {
    publishPlatformEvent({
      type: 'app.deployment.activated',
      appId: id,
      deploymentRevision: deployment.id,
    });
  }

  // Retire instances of the replaced build (they finish the requests they
  // hold), then re-apply the keep-alive contract for the *restored* manifest:
  // rolling back to/from a long-running backend must flip warm-start
  // accordingly (stopApp cleared it).
  stopApp(id, { keepDeploymentId: deployment.id });
  if (!compatibility.isSupported) {
    await closeDataRealtime(id);
  }
  const longRunning =
    compatibility.isSupported &&
    manifest?.backendMode === 'long-running' &&
    Boolean(manifest?.capabilities?.backend);
  if (longRunning) {
    setKeepAlive(id, true);
    try {
      await ensureAppRunning(id, deployment.id);
    } catch {
      /* warm-start is best-effort; requests will retry the boot */
    }
  }
  // Reload schedules from the restored deployment's manifest.
  await reloadScheduler();
  // A restored native frontend ships under this activation's build number.
  await signActivatedPackage(id, manifest);
  return {
    version: deployment.version,
    compatibility,
    dataSchemaMismatch:
      !dataMigrationResolved ||
      (Boolean(deployment.dataSchemaHash || latestDataSchemaHash) &&
        (deployment.dataSchemaHash ?? null) !== latestDataSchemaHash),
  };
}

/**
 * Roll back by user-facing version number (e.g. 4 → v4). Resolves the version
 * to its deployment row, then uses the Agent-only compatibility override while
 * retaining every artifact, source-tag, identity, and Data cutover validation.
 * Versions — not opaque deployment ids — are how Agent-facing deployment
 * history is referred to everywhere (UI, tags, get_app).
 */
export async function rollbackAppToVersion(
  id: string,
  version: number,
): Promise<AppRollbackResult> {
  const deployment = await db.query.deployments.findFirst({
    where: { appId: id, version },
  });
  if (!deployment) {
    throw new Error(`App "${id}" has no deployment v${version}.`);
  }
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () =>
      rollbackAppInner(id, deployment.id, {
        allowUnsupportedCompatibility: true,
      }),
    ),
  );
}

/** Permanently delete an app: process, database, rows, and all artifacts. */
export function deleteApp(id: string): Promise<{ ok: true }> {
  // The id flows into `fs.rm(..., { force: true })` on several per-app dirs, so
  // reject anything that isn't a valid app slug before touching the filesystem.
  // Otherwise a crafted id like "../../src" (which matches no DB row) would
  // still resolve outside the app namespace and delete arbitrary directories.
  if (!isValidAppId(id)) {
    throw new Error(`Invalid app id: ${id}`);
  }
  // Match deploy/rollback lock ordering. The cross-process cutover lock keeps a
  // migration from provisioning or mutating the Data DB while deletion drains
  // readers and drops it; the process lock also serializes local filesystem work.
  return appDeployLock.withLock(id, () =>
    withAppDataCutoverLock(id, () => deleteAppInner(id)),
  );
}

async function deleteAppInner(id: string): Promise<{ ok: true }> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: {
      capabilities: true,
      dataDbName: true,
      dataDbPasswordCiphertext: true,
      dataSchemaHash: true,
      dataActivationId: true,
    },
  });
  const hasManagedData = Boolean(
    app?.dataDbName ||
    app?.dataSchemaHash ||
    app?.dataActivationId ||
    app?.capabilities?.dataTable,
  );

  // Fail closed before draining Data transactions. New requests now reject on
  // platform state while an exclusive migration barrier waits for requests that
  // had already passed their guard.
  await db
    .update(schema.apps)
    .set({ status: 'archived' })
    .where(eq(schema.apps.id, id));
  killApp(id);
  if (hasManagedData) {
    await closeDataRealtime(id);
    if (app?.dataDbPasswordCiphertext) {
      await waitForDataMigrationBarrier(id);
    }

    // Data DB ownership is derived from the reusable App id. Do not delete the
    // platform row when cleanup fails: losing that ownership record would let a
    // future App with the same id inherit an orphaned database and its rows.
    await dropAppDataDatabase(id);
  }

  // Drop the legacy raw-SQL App database best-effort, preserving its established
  // lifecycle behavior. Managed Data cleanup above is the strict boundary.
  try {
    await dropAppDatabase(id);
  } catch {
    /* best-effort */
  }
  // Cascades to deployments, dashboard widgets, and sidebar items.
  await db.delete(schema.apps).where(eq(schema.apps.id, id));
  await Promise.all([
    fs.rm(appSrcDir(id), { recursive: true, force: true }),
    fs.rm(appBuildDir(id), { recursive: true, force: true }),
    fs.rm(appVersionsDir(id), { recursive: true, force: true }),
    fs.rm(appArtifactsDir(id), { recursive: true, force: true }),
    fs.rm(appNativePackagesDir(id), { recursive: true, force: true }),
    fs.rm(appRepoDir(id), { recursive: true, force: true }),
    fs.rm(appStorageDir(id), { recursive: true, force: true }),
    removeAppIconFiles(id),
  ]);
  // Cancel any scheduled cron jobs for the removed app.
  await reloadScheduler();
  return { ok: true };
}
