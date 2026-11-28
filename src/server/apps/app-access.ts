/**
 * Server-only: App-to-App access declared by `appAccess` in the manifest.
 * The relay itself lives in `runtime-api/access/`.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { AppAccessGrant, NormalizedManifest } from './manifest';
import { manifestInvalid } from './manifest-validation';

/**
 * Deploy-time check that every granted target exists and is not archived.
 * What a target exposes is checked per call, since it deploys on its own.
 */
export async function assertAppAccessTargets(
  grants: readonly AppAccessGrant[] | undefined,
): Promise<void> {
  if (!grants || grants.length === 0) return;
  const rows = await db.query.apps.findMany({
    where: { id: { in: grants.map((grant) => grant.app) } },
    columns: { id: true, status: true },
  });
  const status = new Map(rows.map((row) => [row.id, row.status]));
  for (const [index, grant] of grants.entries()) {
    const found = status.get(grant.app);
    if (found === undefined) {
      throw manifestInvalid(
        ['appAccess', index, 'app'],
        `names no App with id "${grant.app}"; use an id from hatch app list --json`,
      );
    }
    if (found === 'archived') {
      throw manifestInvalid(
        ['appAccess', index, 'app'],
        `names the archived App "${grant.app}"`,
      );
    }
  }
}

/** One granted item and whether the target's live deployment has it. */
export type AppAccessItem = { name: string; present: boolean };

export type AppAccessTargetStatus =
  | 'ready'
  | 'missing'
  | 'archived'
  | 'undeployed';

/** A grant's items, each marked against the target's live deployment. */
export type AppAccessGrantItems = {
  rpc: AppAccessItem[];
  dataTables: { read: AppAccessItem[]; write: AppAccessItem[] };
  tasks: AppAccessItem[];
  webhook: AppAccessItem[];
};

/** A target this App's live deployment may reach. */
export type AppAccessOutgoing = {
  appId: string;
  alias: string | null;
  slug: string | null;
  name: string | null;
  targetStatus: AppAccessTargetStatus;
} & AppAccessGrantItems;

/**
 * Another App whose live deployment may reach this one. Each item reports
 * whether this App's live deployment has it.
 */
export type AppAccessIncoming = {
  appId: string;
  alias: string | null;
  slug: string;
  name: string;
} & AppAccessGrantItems;

export type AppAccessOverview = {
  outgoing: AppAccessOutgoing[];
  incoming: AppAccessIncoming[];
};

type TargetSurface = {
  services: Map<string, Set<string>>;
  tables: Set<string>;
  tasks: Set<string>;
  webhook: boolean;
};

function targetSurface(
  manifest: NormalizedManifest | null,
  dataSchema: unknown,
): TargetSurface {
  const tables = (dataSchema as { tables?: Record<string, unknown> } | null)
    ?.tables;
  return {
    services: new Map(
      (manifest?.api?.services ?? []).map((service) => [
        service.name,
        new Set(service.methods.map((method) => method.name)),
      ]),
    ),
    tables: new Set(tables ? Object.keys(tables) : []),
    tasks: new Set(
      (manifest?.tasks?.definitions ?? []).map((task) => task.name),
    ),
    webhook: Boolean(manifest?.capabilities?.webhook),
  };
}

function rpcPresent(surface: TargetSurface, entry: string): boolean {
  if (entry === '*') return surface.services.size > 0;
  const slash = entry.indexOf('/');
  const methods = surface.services.get(entry.slice(0, slash));
  if (!methods) return false;
  const method = entry.slice(slash + 1);
  return method === '*' || methods.has(method);
}

function outgoingView(
  grant: AppAccessGrant,
  target:
    | {
        slug: string;
        name: string;
        status: string;
        currentDeploymentId: string | null;
      }
    | undefined,
  surface: TargetSurface | null,
): AppAccessOutgoing {
  const targetStatus: AppAccessTargetStatus = !target
    ? 'missing'
    : target.status === 'archived'
      ? 'archived'
      : !target.currentDeploymentId || !surface
        ? 'undeployed'
        : 'ready';
  return {
    appId: grant.app,
    alias: grant.alias ?? null,
    slug: target?.slug ?? null,
    name: target?.name ?? null,
    targetStatus,
    ...grantItems(grant, targetStatus === 'ready' ? surface : null),
  };
}

/** Mark each granted item by whether `surface` has it; none without one. */
function grantItems(
  grant: AppAccessGrant,
  surface: TargetSurface | null,
): AppAccessGrantItems {
  const items = (names: string[], present: (name: string) => boolean) =>
    names.map((name) => ({ name, present: Boolean(surface && present(name)) }));
  return {
    rpc: items(grant.rpc, (entry) => rpcPresent(surface!, entry)),
    dataTables: {
      read: items(grant.dataTables.read, (table) => surface!.tables.has(table)),
      write: items(grant.dataTables.write, (table) =>
        surface!.tables.has(table),
      ),
    },
    tasks: items(grant.tasks, (task) => surface!.tasks.has(task)),
    webhook: items(grant.webhook, () => surface!.webhook),
  };
}

/**
 * What App `id` may reach in other Apps, and which Apps may reach it, both
 * from the live deployments. Each outgoing item reports whether the target's
 * live deployment currently has it.
 */
export async function appAccessOverview(
  id: string,
): Promise<AppAccessOverview> {
  const app = await db.query.apps.findFirst({
    where: { id },
    columns: { currentDeploymentId: true },
  });
  const deployment = app?.currentDeploymentId
    ? await db.query.deployments.findFirst({
        where: { id: app.currentDeploymentId },
        columns: { manifestNormalized: true, dataSchemaSnapshot: true },
      })
    : undefined;
  const ownSurface = deployment
    ? targetSurface(
        deployment.manifestNormalized as NormalizedManifest | null,
        deployment.dataSchemaSnapshot,
      )
    : null;
  const grants =
    (deployment?.manifestNormalized as NormalizedManifest | null)?.appAccess ??
    [];

  const targets =
    grants.length > 0
      ? await db.query.apps.findMany({
          where: { id: { in: grants.map((grant) => grant.app) } },
          columns: {
            id: true,
            slug: true,
            name: true,
            status: true,
            currentDeploymentId: true,
          },
        })
      : [];
  const targetDeploymentIds = targets.flatMap((target) =>
    target.currentDeploymentId ? [target.currentDeploymentId] : [],
  );
  const targetDeployments =
    targetDeploymentIds.length > 0
      ? await db.query.deployments.findMany({
          where: { id: { in: targetDeploymentIds } },
          columns: {
            id: true,
            manifestNormalized: true,
            dataSchemaSnapshot: true,
          },
        })
      : [];
  const surfaces = new Map(
    targetDeployments.map((row) => [
      row.id,
      targetSurface(
        row.manifestNormalized as NormalizedManifest | null,
        row.dataSchemaSnapshot,
      ),
    ]),
  );
  const byId = new Map(targets.map((target) => [target.id, target]));
  const outgoing = grants.map((grant) => {
    const target = byId.get(grant.app);
    return outgoingView(
      grant,
      target,
      target?.currentDeploymentId
        ? (surfaces.get(target.currentDeploymentId) ?? null)
        : null,
    );
  });

  const callers = await db
    .select({
      id: schema.apps.id,
      slug: schema.apps.slug,
      name: schema.apps.name,
      manifest: schema.deployments.manifestNormalized,
    })
    .from(schema.apps)
    .innerJoin(
      schema.deployments,
      eq(schema.deployments.id, schema.apps.currentDeploymentId),
    )
    .where(
      and(
        ne(schema.apps.status, 'archived'),
        ne(schema.apps.id, id),
        sql`${schema.deployments.manifestNormalized} -> 'appAccess' @> jsonb_build_array(jsonb_build_object('app', ${id}::text))`,
      ),
    )
    .orderBy(asc(schema.apps.name), asc(schema.apps.id));
  const incoming = callers.flatMap((caller): AppAccessIncoming[] => {
    const grant = (
      caller.manifest as NormalizedManifest | null
    )?.appAccess?.find((entry) => entry.app === id);
    if (!grant) return [];
    return [
      {
        appId: caller.id,
        alias: grant.alias ?? null,
        slug: caller.slug,
        name: caller.name,
        ...grantItems(grant, ownSurface),
      },
    ];
  });
  return { outgoing, incoming };
}
