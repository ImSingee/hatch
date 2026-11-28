/**
 * Server-only: read the external docs an App published with its current
 * deployment. Shared by the public Connect API and the Web UI.
 */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { db } from '~/db';
import { deploymentArtifactDir } from '~agent/paths';
import { AppError } from '~server/errors';
import {
  APP_DOC_ID_RE,
  appDocArtifactPath,
  projectAppManifestUrls,
  type NormalizedManifest,
  type PublishedAppDoc,
  type WebhookAuth,
} from './manifest';

/** Platform-relative URLs external callers use alongside the docs. */
export type AppDocEndpoints = {
  webhook?: { url: string; auth: WebhookAuth };
  rpc?: { url: string; service: string };
};

export type AppDocIndex = {
  appId: string;
  version: number;
  deploymentId: string;
  docs: PublishedAppDoc[];
  endpoints: AppDocEndpoints;
};

export type AppDocContent = {
  appId: string;
  version: number;
  deploymentId: string;
  doc: PublishedAppDoc;
  content: string;
};

export type CurrentDeployment = {
  appId: string;
  version: number;
  deploymentId: string;
  manifest: NormalizedManifest;
};

/**
 * The App's live deployment, with its manifest URLs projected for the App.
 * Archived or never-deployed Apps conflict; they publish no docs.
 */
export async function currentDeployment(
  appId: string,
): Promise<CurrentDeployment> {
  const app = await db.query.apps.findFirst({
    where: { id: appId },
    columns: { id: true, slug: true, status: true, currentDeploymentId: true },
  });
  if (!app) throw new AppError(`App "${appId}" not found.`, 404);
  if (app.status === 'archived') {
    throw new AppError(
      `App "${appId}" is archived; its docs are not published.`,
      409,
    );
  }
  if (!app.currentDeploymentId) {
    throw new AppError(
      `App "${appId}" has no live deployment; deploy it to publish docs.`,
      409,
    );
  }
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId },
    columns: { id: true, version: true, manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as
    | NormalizedManifest
    | null
    | undefined;
  if (!deployment || !manifest) {
    throw new AppError(`App "${appId}" has no live deployment.`, 409);
  }
  return {
    appId: app.id,
    version: deployment.version,
    deploymentId: deployment.id,
    manifest: projectAppManifestUrls(manifest, app.id, app.slug),
  };
}

/** Index of the current deployment's docs plus the endpoints they describe. */
export async function listAppDocs(appId: string): Promise<AppDocIndex> {
  const current = await currentDeployment(appId);
  const { webhook, rpc } = current.manifest;
  return {
    appId: current.appId,
    version: current.version,
    deploymentId: current.deploymentId,
    // Deployments built before docs existed have no index.
    docs: current.manifest.docs ?? [],
    endpoints: {
      ...(webhook ? { webhook: { url: webhook.url, auth: webhook.auth } } : {}),
      ...(rpc ? { rpc: { url: rpc.url, service: rpc.service } } : {}),
    },
  };
}

/**
 * Read one doc body from the current deployment's immutable artifact. The
 * artifact directory never changes after release, so a concurrent deploy or
 * rollback cannot mix a new index with an old body.
 */
export async function readAppDoc(
  appId: string,
  docId: string,
): Promise<AppDocContent> {
  if (!APP_DOC_ID_RE.test(docId)) {
    throw new AppError(`Invalid doc id "${docId}".`, 400);
  }
  const current = await currentDeployment(appId);
  const doc = current.manifest.docs?.find((entry) => entry.id === docId);
  if (!doc) {
    throw new AppError(
      `App "${appId}" version ${current.version} has no doc "${docId}".`,
      404,
    );
  }
  const file = path.join(
    deploymentArtifactDir(current.appId, current.deploymentId),
    appDocArtifactPath(doc.id),
  );
  const handle = await fs
    .open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new AppError(
          `Doc "${docId}" is missing from the deployment artifact.`,
          503,
        );
      }
      throw error;
    });
  try {
    return {
      appId: current.appId,
      version: current.version,
      deploymentId: current.deploymentId,
      doc,
      content: await handle.readFile('utf8'),
    };
  } finally {
    await handle.close();
  }
}
