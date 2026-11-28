/**
 * Allowlisted JSON views. No database rows, credentials or build logs.
 * Server output only: clients must tolerate additive fields and values.
 */
import { z } from 'zod';
import { extraPermissionsSchema } from '../../packages/hatch-manifest/src/extra-permissions.js';
import { networkPolicySchema } from '../../packages/hatch-manifest/src/network-policy.js';

const extraPermissionsView = z
  .object({ flags: extraPermissionsSchema, hostAccess: z.boolean() })
  .strict();

const str = z.string();
const nullable = str.nullable();
const timestamp = z.iso.datetime();
const mode = z.enum(['serverless', 'long-running']);
export const compatibilitySchema = z
  .object({
    version: z.number().int(),
    latestVersion: z.number().int(),
    minimumSupportedVersion: z.number().int(),
    isSupported: z.boolean(),
    isLatest: z.boolean(),
  })
  .strict();
export const resourceSchema = z
  .object({
    id: str,
    slug: str,
    name: str,
    description: nullable,
    status: z.enum(['draft', 'building', 'deployed', 'failed', 'archived']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const appSummarySchema = resourceSchema
  .extend({
    currentVersion: z.number().nullable(),
    compatibility: compatibilitySchema.nullable(),
    capabilities: z.array(str),
  })
  .strict();
const footprint = z.object({ w: z.number(), h: z.number() });
const cron = z.object({
  name: str,
  schedule: str,
  method: str.optional(),
  path: str.optional(),
});
const url = z.object({ url: str });
/** Index entry of one published external doc; the body is read separately. */
export const appDocView = z.object({
  id: str,
  title: str,
  description: str.optional(),
  path: str,
  bytes: z.number().int(),
  sha256: str,
});
const appAccessLists = {
  rpc: z.array(str),
  dataTables: z.object({ read: z.array(str), write: z.array(str) }).strict(),
  tasks: z.array(str),
  webhook: z.array(str),
};
const appAccessGrantView = z
  .object({ app: str, alias: str.optional(), ...appAccessLists })
  .strict();
const appAccessItem = z.object({ name: str, present: z.boolean() }).strict();
const appAccessItems = {
  rpc: z.array(appAccessItem),
  dataTables: z
    .object({
      read: z.array(appAccessItem),
      write: z.array(appAccessItem),
    })
    .strict(),
  tasks: z.array(appAccessItem),
  webhook: z.array(appAccessItem),
};
const appAccessOverview = z
  .object({
    outgoing: z.array(
      z
        .object({
          appId: str,
          alias: nullable,
          slug: nullable,
          name: nullable,
          targetStatus: z.enum(['ready', 'missing', 'archived', 'undeployed']),
          ...appAccessItems,
        })
        .strict(),
    ),
    incoming: z.array(
      z
        .object({
          appId: str,
          alias: nullable,
          slug: str,
          name: str,
          ...appAccessItems,
        })
        .strict(),
    ),
  })
  .strict();
export const appManifestViewSchema = z.object({
  id: str,
  name: str,
  description: str,
  capabilities: z.object({
    frontend: z.boolean(),
    widgets: z.boolean(),
    backend: z.boolean(),
    database: z.boolean(),
    cron: z.boolean(),
    webhook: z.boolean(),
    storage: z.boolean(),
    kv: z.boolean(),
    dataTable: z.boolean(),
    notifications: z.boolean().optional(),
    tasks: z.boolean().optional(),
  }),
  backendMode: mode,
  backend: z
    .object({
      entry: str,
      runtime: z.enum(['deno-run', 'deno-serve']).optional(),
      format: z.literal('bundle-v1').optional(),
      network: networkPolicySchema.optional(),
      extraPermissions: extraPermissionsSchema.optional(),
    })
    .optional(),
  app: z
    .object({
      url: str,
      routes: z.array(z.object({ path: str, description: str })).optional(),
      runtime: z.literal('native').optional(),
      nshVersion: str.optional(),
    })
    .optional(),
  widgets: z.array(
    z.object({
      id: str,
      name: str,
      url: str,
      defaultSize: footprint,
      supportedSizes: z.array(footprint),
    }),
  ),
  rpc: z.object({ url: str, service: str }).optional(),
  cron: z.array(cron),
  webhook: z
    .object({ url: str, auth: z.enum(['platform', 'none']) })
    .optional(),
  kv: url.optional(),
  dataTable: url.optional(),
  tasks: z
    .object({
      concurrency: z.number().int(),
      definitions: z.array(
        z.object({
          name: str,
          method: str,
          title: str.optional(),
          description: str.optional(),
          concurrency: z.number().int().optional(),
          cron: z.array(
            z.object({
              name: str,
              schedule: str,
              input: z.record(str, z.unknown()),
            }),
          ),
          webhook: z.boolean(),
          inputType: str,
          inputSchema: z.record(str, z.unknown()),
        }),
      ),
    })
    .optional(),
  notifications: z
    .object({
      url: str,
      kinds: z.array(
        z.object({ kind: str, name: str, description: str.optional() }),
      ),
      destination: z.object({ description: str.optional() }).optional(),
    })
    .optional(),
  api: z
    .object({
      services: z.array(
        z.object({
          name: str,
          methods: z.array(
            z.object({
              name: str,
              inputType: str,
              outputType: str,
              clientStreaming: z.boolean(),
              serverStreaming: z.boolean(),
            }),
          ),
        }),
      ),
      protoFiles: z.array(z.object({ path: str, content: str })),
    })
    .optional(),
  docs: z.array(appDocView).optional(),
  keyboard: z.object({ reserve: z.array(str) }).optional(),
  appAccess: z.array(appAccessGrantView).optional(),
});
const networkView = z
  .object({
    mode: z.enum(['blocked', 'restricted', 'unrestricted']),
    destinations: z.array(str),
    legacy: z.boolean(),
  })
  .strict();
const history = z.object({
  version: z.number(),
  status: str,
  error: nullable,
  createdAt: timestamp,
  isCurrent: z.boolean(),
  canRollback: z.boolean(),
  compatibility: compatibilitySchema,
});
export const appDetailSchema = appSummarySchema
  .extend({
    backendMode: mode.nullable(),
    dbName: nullable,
    dataDbName: nullable,
    currentDeploymentId: nullable,
    currentSourceCommit: nullable,
    manifest: appManifestViewSchema.nullable(),
    frontend: z
      .object({
        runtime: z.enum(['web', 'native']),
        nshVersion: nullable,
        packageBuild: z.number().int().nullable(),
      })
      .strict()
      .nullable(),
    ops: z
      .object({
        backend: z
          .object({
            capable: z.boolean(),
            mode: mode.nullable(),
            running: z.boolean(),
            network: networkView.nullable(),
            extraPermissions: extraPermissionsView.nullable(),
          })
          .strict(),
        cron: z
          .object({
            enabled: z.boolean(),
            jobs: z.array(
              z
                .object({
                  name: str,
                  schedule: str,
                  method: nullable,
                  path: nullable,
                  nextRun: timestamp.nullable(),
                })
                .strict(),
            ),
          })
          .strict(),
        webhook: z
          .object({
            enabled: z.boolean(),
            url: nullable,
            hasSecret: z.boolean(),
            auth: z.enum(['platform', 'none']),
          })
          .strict(),
        storage: z.object({ enabled: z.boolean() }).strict(),
        kv: z
          .object({
            enabled: z.boolean(),
            url: nullable,
            entryCount: z.number(),
          })
          .strict(),
        dataTable: z
          .object({
            enabled: z.boolean(),
            url: nullable,
            dbName: nullable,
            schemaHash: nullable,
          })
          .strict(),
        appAccess: appAccessOverview,
      })
      .strict(),
    deployments: z.array(
      history
        .extend({
          id: str,
          dataSchemaMismatch: z.boolean(),
          rollbackBlockedReason: nullable,
          sourceCommit: nullable,
          sourceTag: nullable,
        })
        .strict(),
    ),
  })
  .strict();
export const releaseSchema = z
  .object({
    deploymentId: str,
    version: z.number().int().positive(),
    compatibilityVersion: z.number().int().positive(),
  })
  .strict();
