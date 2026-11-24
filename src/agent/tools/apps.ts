/**
 * App lifecycle tools: list, inspect, checkout, create, deploy, rollback,
 * database, persistent storage, and KV.
 * All platform state flows through the injected PlatformClient (REST to the
 * platform's internal API); source trees live in runner-local worktrees fed
 * by git bundles.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { APP_NAME_MAX_LENGTH, APP_SLUG_MAX_LENGTH } from '~/app-identity';
import {
  AppPreparationError,
  prepareAppWorktree,
} from '../app-worktree-prepare';
import { appHatchSdkMaterializer } from '../hatch-sdk';
import {
  assertWorkspacePathAvailable,
  bundleWorktreeForDeploy,
  checkoutFromBundle,
  initNewWorktree,
  type LocalCheckout,
  withSourceWorkspaceLock,
} from '../local-sources';
import { agentAppWorkDir } from '../paths';
import type { PlatformClient } from '../platform-client';
import {
  QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH,
  queryAppDataTableRequestSchema,
  queryAppDataTableCursorSchema,
  queryAppDbRequestSchema,
  queryAppKvCursorSchema,
  queryAppKvRequestSchema,
  createAppRequestSchema,
} from '../protocol';
import { writeScaffoldFiles } from '../scaffold-files';
import {
  materializeWorktree,
  WorktreeMaterializationError,
} from '../worktree-materializer';
import { resolveAgentWorkspacePath } from '../workspace-paths';
import {
  compatibilityDetailGuidance,
  compatibilityListSummary,
  compatibilityRollbackWarning,
} from './compatibility';
import { formatExtraPermissions } from './extra-permissions';
import { formatNetworkAccess } from './network-access';
import { requireIdSlug, requireSessionId, text, tool } from './shared';

const DATABASE_DATA_GUIDANCE =
  'Database persists across deployments and capability disable/re-enable. It may contain historical data; inspect its schema and rows with query_app_db before initializing or changing data.';
const DATA_TABLE_DATA_GUIDANCE =
  'Data Tables persist across capability disable/re-enable unless explicitly deleted. Inspect the existing schema and rows with query_app_data_table before initializing or changing data.';

function checkoutLines(id: string, checkout: LocalCheckout): string[] {
  return [
    checkout.replacedExisting
      ? `Replaced existing checkout for "${id}" at ${checkout.absolutePath}. ` +
        'All previous local work at that path was discarded.'
      : checkout.synchronizedExisting
        ? `Synchronized existing checkout for "${id}" at ` +
          `${checkout.absolutePath} to remote master.`
        : `Checked out "${id}" at ${checkout.absolutePath}.`,
    checkout.headCommit
      ? `HEAD: ${checkout.headCommit}`
      : 'No commits yet. Create files, then run git add and git commit.',
    checkout.remoteCommit
      ? `Remote master: ${checkout.remoteCommit}`
      : 'Remote master has no commits yet.',
    checkout.dirty
      ? `Worktree has local changes:\n${checkout.status}`
      : 'Worktree is clean.',
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preparationFailure(
  context: string,
  stage: 'SDK materialization' | 'dependency install or Connect codegen',
  error: unknown,
): Error {
  const stageError =
    error instanceof WorktreeMaterializationError && error.cause !== undefined
      ? error.cause
      : error;
  const reason =
    stageError instanceof AppPreparationError
      ? stageError.message
      : `App preparation failed during ${stage}: ${errorMessage(stageError)}`;
  return new Error(`${context}, but ${reason}`);
}

type PrepareWorktree = (root: string, signal?: AbortSignal) => Promise<void>;

export function createAppTools(options: {
  sessionId?: string;
  platform: PlatformClient;
  /** Test seam for platform-owned SDK materialization. */
  materializeSdk?: (root: string) => Promise<void>;
  /** Test seam for the generated dependency/codegen preparation step. */
  prepareWorktree?: PrepareWorktree;
}): AgentTool[] {
  const { platform } = options;
  const materializeSdk =
    options.materializeSdk ?? appHatchSdkMaterializer.materialize;
  const sdkMaterializer = {
    gitExcludePatterns: appHatchSdkMaterializer.gitExcludePatterns,
    materialize: materializeSdk,
  };
  const prepareWorktree = options.prepareWorktree ?? prepareAppWorktree;

  const listAppsTool = tool({
    name: 'list_apps',
    label: 'List apps',
    description:
      'List every app on the platform with its status, live version, and ' +
      'enabled capabilities.',
    parameters: z.object({}),
    execute: async () => {
      const apps = await platform.listApps();
      if (apps.length === 0) {
        return text('No apps exist yet.', { apps });
      }
      const lines = apps.map((a) => {
        const version =
          a.currentVersion != null
            ? ` v${a.currentVersion}`
            : ' (not deployed)';
        const caps =
          a.capabilities.length > 0 ? ` — ${a.capabilities.join(', ')}` : '';
        const compatibility = a.compatibility
          ? ` · compatibility v${a.compatibility.version}${compatibilityListSummary(a.compatibility)}`
          : '';
        return `- ${a.name} (id: ${a.id}, slug: ${a.slug}) [${a.status}]${version}${compatibility}${caps}`;
      });
      return text(lines.join('\n'), { apps });
    },
  });

  const getAppTool = tool({
    name: 'get_app',
    label: 'Get app details',
    description:
      "Get one app's details: status, live version, capabilities, the " +
      'user-facing App URL, normalized widget/RPC/webhook URLs, runtime state ' +
      '(backend running, network declaration, cron jobs), and deployment ' +
      'history. Mirrors the app management panel.',
    parameters: z.object({ id: z.string().describe('App id.') }),
    execute: async (_id, params) => {
      requireIdSlug(params.id);
      const detail = await platform.getApp(params.id);
      if (!detail) throw new Error(`App "${params.id}" not found.`);
      const m = detail.manifest;
      const databaseEnabled = detail.capabilities.includes('database');
      const databaseStatus = detail.dbName
        ? `${detail.dbName} (${databaseEnabled ? 'enabled' : 'disabled, retained'})`
        : databaseEnabled
          ? 'enabled, not provisioned'
          : 'not provisioned';
      const dataTableEnabled = detail.capabilities.includes('dataTable');
      const dataTableStatus = detail.ops.dataTable.dbName
        ? `${detail.ops.dataTable.dbName} (${
            dataTableEnabled ? 'enabled' : 'disabled, retained'
          }; ${detail.ops.dataTable.schemaHash?.slice(0, 10) ?? 'no schema'})`
        : dataTableEnabled
          ? 'enabled, not provisioned'
          : 'not provisioned';
      const lines: (string | null)[] = [
        `${detail.name} (slug: ${detail.slug}, id: ${detail.id}) — ${detail.status}` +
          (detail.currentVersion != null
            ? ` · v${detail.currentVersion}`
            : ' · not deployed'),
        detail.description ? `Description: ${detail.description}` : null,
        detail.compatibility
          ? `Compatibility: v${detail.compatibility.version} ` +
            `(latest v${detail.compatibility.latestVersion}, minimum v${detail.compatibility.minimumSupportedVersion})` +
            compatibilityDetailGuidance(detail.compatibility)
          : null,
        `Backend: ${
          detail.ops.backend.capable
            ? `${detail.backendMode ?? 'serverless'}${
                detail.ops.backend.running ? ' (running)' : ''
              }`
            : 'none'
        }`,
        detail.ops.backend.capable
          ? `Network: ${formatNetworkAccess(detail.ops.backend.network)}`
          : null,
        detail.ops.backend.capable
          ? `Extra permissions: ${formatExtraPermissions(detail.ops.backend.extraPermissions)}`
          : null,
        `Database: ${databaseStatus}`,
        `Data Tables: ${dataTableStatus}`,
        databaseEnabled && detail.dbName ? DATABASE_DATA_GUIDANCE : null,
        dataTableEnabled && detail.ops.dataTable.dbName
          ? DATA_TABLE_DATA_GUIDANCE
          : null,
        detail.ops.storage.enabled
          ? 'Persistent storage: enabled (backend STORAGE_DIR)'
          : null,
        `Capabilities: ${
          detail.capabilities.length > 0
            ? detail.capabilities.join(', ')
            : 'none detected yet'
        }`,
        m?.app ? `App URL: ${m.app.url}` : null,
        m?.rpc ? `RPC: ${m.rpc.url} (${m.rpc.service})` : null,
        m && m.widgets.length > 0
          ? `Widgets: ${m.widgets.map((w) => `${w.id} (${w.url})`).join(', ')}`
          : null,
        detail.ops.webhook.enabled
          ? `Webhook: ${detail.ops.webhook.url ?? 'n/a'}${
              detail.ops.webhook.hasSecret ? ' [secret set]' : ''
            }`
          : null,
        detail.ops.cron.enabled
          ? `Cron: ${
              detail.ops.cron.jobs.length > 0
                ? detail.ops.cron.jobs
                    .map((j) => `${j.name} [${j.schedule}]`)
                    .join(', ')
                : 'no jobs'
            }`
          : null,
        '',
        'Deployments (newest first):',
        ...detail.deployments
          .slice(0, 10)
          .flatMap((d) => [
            `  v${d.version} — ${d.status} · compatibility v${d.compatibility.version}${d.isCurrent ? ' (current)' : ''}${
              d.canRollback ? ' [rollbackable]' : ''
            }${!d.compatibility.isSupported ? ' [Agent restore only; runtime disabled]' : ''}${d.dataSchemaMismatch ? ' [Data Table schema differs]' : ''} · ${d.createdAt}`,
            d.sourceTag ? `    Source tag: ${d.sourceTag}` : null,
            d.sourceCommit ? `    Source commit: ${d.sourceCommit}` : null,
            d.rollbackBlockedReason
              ? `    Restore blocked: ${d.rollbackBlockedReason}`
              : null,
          ]),
      ];
      return text(lines.filter((l) => l !== null).join('\n'), detail);
    },
  });

  const checkoutAppTool = tool({
    name: 'checkout_app',
    label: 'Clone or update app',
    description:
      "Clone an app's Git repo into this conversation, or update an existing " +
      'checkout in place. Set clone: true to create a fresh checkout at ' +
      'source_path or apps/<slug>. Set clone: false and provide source_path to ' +
      'update that exact checkout; update never creates or replaces a path. ' +
      'Before returning, it reproduces frozen dependencies from the committed ' +
      'lockfile, generates Connect stubs, and materializes the platform-owned ' +
      'Hatch SDK. Dependency lifecycle scripts never run.',
    executionMode: 'sequential',
    parameters: z.object({
      id: z.string().describe('App id.'),
      clone: z
        .boolean()
        .describe(
          'True to create a fresh checkout; false to update the existing ' +
            'checkout at source_path.',
        ),
      source_path: z
        .string()
        .min(1)
        .describe(
          'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Required when clone is false. When clone is true, defaults ' +
            'to apps/<slug>.',
        )
        .optional(),
      force: z
        .boolean()
        .describe(
          'Only valid when clone is true. Replace an existing source_path ' +
            'with a fresh checkout. Defaults to false and permanently ' +
            'discards local work at that exact path.',
        )
        .optional(),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      if (!params.clone && !params.source_path) {
        throw new Error('source_path is required when clone is false.');
      }
      if (!params.clone && params.force) {
        throw new Error('force is only valid when clone is true.');
      }
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          let sourcePath = params.source_path;
          let sourceAppId = params.id;
          if (!sourcePath) {
            const detail = await platform.getApp(params.id);
            if (!detail) throw new Error(`App "${params.id}" not found.`);
            sourceAppId = detail.id;
            sourcePath = agentAppWorkDir(sessionId, detail.slug);
          }
          const { appId } = await platform.associateSessionApp(
            sessionId,
            sourceAppId,
          );
          const source = await platform.getAppSource(appId);
          const resolved = await resolveAgentWorkspacePath(
            sessionId,
            sourcePath,
          );
          let checkout: LocalCheckout;
          try {
            checkout = await checkoutFromBundle(sessionId, source, {
              targetPath: sourcePath,
              force: params.clone ? (params.force ?? false) : false,
              mode: params.clone ? 'clone' : 'update',
              materializer: sdkMaterializer,
            });
          } catch (error) {
            if (error instanceof WorktreeMaterializationError) {
              throw preparationFailure(
                `Checked out "${source.id}" at ${resolved.absolutePath}`,
                'SDK materialization',
                error,
              );
            }
            throw error;
          }
          const context = `Checked out "${source.id}" at ${checkout.absolutePath}`;
          try {
            await prepareWorktree(checkout.absolutePath, signal);
          } catch (error) {
            throw preparationFailure(
              context,
              'dependency install or Connect codegen',
              error,
            );
          }
          return text(
            [
              ...checkoutLines(source.id, checkout),
              'Preparation: ready (dependencies, Connect stubs, Hatch SDK).',
            ].join('\n'),
            { ...checkout, preparation: 'ready' },
          );
        },
        signal,
      );
    },
  });

  const createAppTool = tool({
    name: 'create_app',
    label: 'Create app',
    description:
      "Scaffold a new app from the platform template in this chat's " +
      'worktree with manifest, proto, Deno backend, React app, a sample ' +
      'widget, package.json, and pnpm-lock.yaml. Before returning, it ' +
      'reproduces frozen dependencies, generates Connect stubs, and ' +
      'materializes the platform-owned Hatch SDK. Dependency lifecycle ' +
      'scripts never run.',
    executionMode: 'sequential',
    parameters: z.object({
      slug: z
        .string()
        .min(1)
        .max(APP_SLUG_MAX_LENGTH)
        .describe(
          'URL slug using lowercase letters, digits, and hyphens, starting ' +
            'with a letter or digit. Used in the ' +
            'human-facing /app/<slug> URL. It can be ' +
            'changed later from the manage page, so it is not permanent; ' +
            'technical APIs use the immutable app id.',
        ),
      name: z
        .string()
        .min(1)
        .max(APP_NAME_MAX_LENGTH)
        .describe('Human-readable name.'),
      description: z.string().describe('One-line description.').optional(),
      pin: z
        .boolean()
        .describe(
          'Pin the app to the sidebar. Pass true when the app will have a ' +
            'user-facing frontend (the default) so it is reachable right away, ' +
            'and false for backend-only or widget-only apps.',
        )
        .optional(),
      target_path: z
        .string()
        .min(1)
        .describe(
          'Absolute path inside this Agent workdir, or a path relative to ' +
            'it. Defaults to apps/<slug>.',
        )
        .optional(),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const { target_path: requestedTargetPath, ...rawInput } = params;
          const input = createAppRequestSchema.parse(rawInput);
          const targetPath =
            requestedTargetPath ??
            agentAppWorkDir(sessionId, input.slug.trim());
          // Keep validation and local initialization under one session lock so
          // parallel create calls cannot both reserve the same target.
          await assertWorkspacePathAvailable(sessionId, targetPath);
          const res = await platform.createApp(input, sessionId);
          const checkout = await initNewWorktree(
            sessionId,
            res.id,
            (root) => writeScaffoldFiles(root, res.files),
            targetPath,
          );
          const context =
            `Created app "${res.name}" (slug: ${res.slug}, id: ${res.id}) ` +
            `at ${checkout.absolutePath}`;
          try {
            await materializeWorktree(checkout.absolutePath, sdkMaterializer);
          } catch (error) {
            throw preparationFailure(context, 'SDK materialization', error);
          }
          try {
            await prepareWorktree(checkout.absolutePath, signal);
          } catch (error) {
            throw preparationFailure(
              context,
              'dependency install or Connect codegen',
              error,
            );
          }
          return text(
            [
              `Created app "${res.name}" (id: ${res.id}, slug: ${res.slug}). ` +
                `Source is at ${checkout.absolutePath}.`,
              'Preparation is ready: dependencies, Connect stubs, and the Hatch ' +
                'SDK are available. Continue using this checkout; do not clone ' +
                'it again. Read and edit the authored files, run the checks ' +
                'described by the building-apps Skill, then commit and call ' +
                `deploy_app with id "${res.id}" and source_path ` +
                `"${checkout.absolutePath}". To refresh it later, call ` +
                'checkout_app with clone: false and the same source_path.',
            ].join('\n'),
            {
              id: res.id,
              slug: res.slug,
              name: res.name,
              path: checkout.path,
              absolutePath: checkout.absolutePath,
              preparation: 'ready',
            },
          );
        },
        signal,
      );
    },
  });

  const deployAppTool = tool({
    name: 'deploy_app',
    label: 'Deploy app',
    description:
      'Validate and deploy a committed app so it becomes live. Deploy uses ' +
      'trusted Connect codegen, a frozen dependency install, source-level type ' +
      'checks for every enabled manifest entry, and production bundles before ' +
      'database migration or release activation. Requires package.json and a ' +
      'committed lockfile: pnpm-lock.yaml, or deno.json plus deno.lock for an ' +
      'existing Deno-toolchain source, never both. Load the building-apps ' +
      'Skill to repair validation errors. Reports the user-facing App URL ' +
      'plus widget/RPC URLs.',
    executionMode: 'sequential',
    parameters: z.object({
      id: z.string().describe('App id.'),
      source_path: z
        .string()
        .min(1)
        .describe(
          'Absolute path inside this Agent workdir, or a path relative to it, ' +
            'for the app Git worktree. Use the path returned by create_app or ' +
            'checkout_app.',
        ),
      message: z
        .string()
        .describe(
          'Required release note describing what this deployment changes ' +
            '(e.g. "Add CSV export"). Shown in the deployment history.',
        ),
      allow_destructive_data_migration: z
        .boolean()
        .describe(
          'Set true only after the user explicitly approves the destructive ' +
            'Data Table migration preview returned by a previous deploy attempt.',
        )
        .optional(),
      data_migration_approval_token: z
        .string()
        .min(1)
        .describe(
          'Exact approval token returned by the destructive Data Table ' +
            'migration preview. Pass it together with ' +
            'allow_destructive_data_migration: true.',
        )
        .optional(),
    }),
    execute: async (_id, params, signal) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      return withSourceWorkspaceLock(
        sessionId,
        async () => {
          const detail = await platform.getApp(params.id);
          if (!detail) throw new Error(`App "${params.id}" not found.`);
          await platform.associateSessionApp(sessionId, detail.id);
          const { bundleBase64 } = await bundleWorktreeForDeploy(
            sessionId,
            detail.id,
            params.source_path,
          );
          const res = await platform.deployApp(detail.id, {
            message: params.message,
            generation: detail.createdAt,
            bundleBase64,
            allowDestructiveDataMigration:
              params.allow_destructive_data_migration,
            dataMigrationApprovalToken: params.data_migration_approval_token,
          });
          const lines = [
            `Deployed "${detail.id}" (v${res.version}, compatibility v${res.compatibilityVersion}).`,
            res.normalized.capabilities.database
              ? DATABASE_DATA_GUIDANCE
              : null,
            res.normalized.capabilities.dataTable
              ? DATA_TABLE_DATA_GUIDANCE
              : null,
            res.normalized.app ? `App URL: ${res.normalized.app.url}` : null,
            res.normalized.widgets.length > 0
              ? `Widgets: ${res.normalized.widgets.map((w) => w.id).join(', ')}`
              : null,
            res.normalized.rpc ? `RPC: ${res.normalized.rpc.url}` : null,
            res.normalized.dataTable
              ? `Data Tables: ${res.normalized.dataTable.url}`
              : null,
          ].filter(Boolean);
          return text(lines.join('\n'), res);
        },
        signal,
      );
    },
  });

  const rollbackAppTool = tool({
    name: 'rollback_app',
    label: 'Rollback app',
    description:
      'Rollback an app to a previous deployment version. Restores that ' +
      "version's artifact and moves the app repo master branch to its " +
      'deployment tag commit. Pass the version number shown by get_app ' +
      '(e.g. 4 to restore v4); only successfully deployed versions can be ' +
      "restored. Agent can restore versions outside the platform's supported " +
      'compatibility range, but their runtime stays disabled until the App or ' +
      'platform is updated. A version requiring an App database or Data Table ' +
      'database cannot be restored after that resource is permanently deleted. ' +
      'Restore its get_app source tag tree onto current master, commit, and ' +
      'deploy as a new release to provision an empty database.',
    parameters: z.object({
      id: z.string().describe('App id.'),
      version: z
        .number()
        .describe('Deployment version to restore, e.g. 4 for v4.'),
    }),
    execute: async (_id, params) => {
      const sessionId = requireSessionId(options.sessionId);
      requireIdSlug(params.id);
      const { appId } = await platform.associateSessionApp(
        sessionId,
        params.id,
      );
      const res = await platform.rollbackApp(appId, params.version);
      const compatibilityWarning = compatibilityRollbackWarning(
        res.compatibility,
      );
      return text(
        `Rolled back "${params.id}" to v${res.version}. ` +
          (res.dataSchemaMismatch
            ? 'Warning: the managed Data Table schema was not rolled back and differs from this code version. '
            : '') +
          (compatibilityWarning ? `${compatibilityWarning} ` : '') +
          'Existing Agent worktrees were not changed. Re-run checkout_app with ' +
          'clone: false and the same source_path. It synchronizes only when ' +
          'remote master fast-forwards a clean local master; ahead or diverged ' +
          'work is preserved. To discard it, make a separate clone: true call ' +
          'with the same source_path and force: true.',
        res,
      );
    },
  });

  const queryAppDb = tool({
    name: 'query_app_db',
    label: 'Query app DB',
    description:
      "Run SQL against an app's already-provisioned Postgres database. This " +
      'tool never provisions or recreates a database; deploy a version with ' +
      'capabilities.database enabled first. A retained database remains ' +
      'queryable after the capability is disabled until the user deletes it. ' +
      'Returns up to 100 rows.',
    parameters: z.object({
      id: z.string().describe('App id.'),
      sql: z.string().min(1).describe('SQL statement to execute.'),
    }),
    execute: async (_id, params, signal) => {
      requireIdSlug(params.id);
      queryAppDbRequestSchema.parse({ sql: params.sql });
      // Forward the abort signal so cancelling the run aborts the platform
      // request, which in turn tears down the running statement.
      const res = await platform.queryAppDb(params.id, params.sql, signal);
      return text(res.text, { rowCount: res.rowCount });
    },
  });

  const queryAppKv = tool({
    name: 'query_app_kv',
    label: 'Query app KV',
    preserveEmptyValue: (field, input) =>
      field === 'value' && input.action === 'set',
    description:
      "List, read, write, or permanently delete entries in a deployed app's " +
      'KV store. Secret values are masked by default. For list and get, set ' +
      'reveal_secrets to true only when their plaintext is needed in the model ' +
      'context. For the first list, omit cursor or pass an empty string. ' +
      'To continue, use the nonempty cursor returned by the previous list. ' +
      'The app must already have the kv capability enabled.',
    // Keep the root object-shaped: the Anthropic adapter forwards root
    // properties/required fields and would discard a root anyOf schema.
    parameters: z.object({
      id: z.string().describe('App id.'),
      action: z.union([
        z.literal('list'),
        z.literal('get'),
        z.literal('set'),
        z.literal('delete'),
      ]),
      key: z.string().describe('Required for get, set, and delete.').optional(),
      value: z
        .string()
        .describe('Plaintext string value. Required for set.')
        .optional(),
      secret: z
        .boolean()
        .describe(
          'Set only: secret flag. Omit to preserve it on update; new keys ' +
            'default to false.',
        )
        .optional(),
      // Provider constraints come from the platform contract.
      cursor: queryAppKvCursorSchema
        .describe(
          'List only: cursor returned by the previous call (up to 512 ' +
            'characters). Omit or pass an empty string for the first page.',
        )
        .optional(),
      limit: z
        .int()
        .min(1)
        .max(100)
        .describe('List only: maximum entries. Defaults to 100.')
        .optional(),
      reveal_secrets: z
        .boolean()
        .describe(
          'List and get only: return secret values in plaintext. Defaults ' +
            'to false.',
        )
        .optional(),
    }),
    prepareArguments: (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('KV tool arguments must be an object.');
      }
      // Shared preparation has already removed every empty cursor spelling.
      // Validate nonempty continuations before pi-ai can coerce their types.
      if ('cursor' in args) {
        z.object({ cursor: queryAppKvCursorSchema.optional() }).parse(args);
      }
      return args;
    },
    execute: async (_id, params, signal) => {
      requireIdSlug(params.id);
      const { id, reveal_secrets: revealSecrets, ...rawInput } = params;
      // The object-rooted provider schema exposes every field. Enforce the
      // action-specific required/allowed combinations before making the REST
      // request, using the same contract as the platform endpoint.
      const input = queryAppKvRequestSchema.parse({
        ...rawInput,
        ...(revealSecrets === undefined ? {} : { revealSecrets }),
      });
      const cursor = input.action === 'list' ? input.cursor : undefined;
      const key = input.action === 'list' ? undefined : input.key;
      const res = await platform.queryAppKv(id, input, signal);
      switch (res.action) {
        case 'list': {
          if (res.items.length === 0) {
            return text(
              cursor
                ? `No KV entries found after cursor ${JSON.stringify(cursor)}.`
                : `App "${id}" has no KV entries.`,
              res,
            );
          }
          const continuation = res.nextCursor
            ? `\nContinue with cursor: ${JSON.stringify(res.nextCursor)}`
            : '';
          return text(
            `${JSON.stringify(res.items, null, 2)}${continuation}`,
            res,
          );
        }
        case 'get':
          return res.record
            ? text(JSON.stringify(res.record, null, 2), res)
            : text(`KV key ${JSON.stringify(key)} is not set.`, res);
        case 'set':
          return text(JSON.stringify(res.record, null, 2), res);
        case 'delete':
          return text(
            res.ok
              ? `Deleted KV key ${JSON.stringify(key)} permanently.`
              : `KV key ${JSON.stringify(key)} was not set.`,
            res,
          );
      }
    },
  });

  const queryAppDataTable = tool({
    name: 'query_app_data_table',
    label: 'Query app Data Table',
    preserveEmptyValue: (field, input) => {
      const match = /^operations\.(\d+)\.(value|amount)$/.exec(field);
      if (
        !match ||
        input.action !== 'mutate' ||
        !Array.isArray(input.operations)
      )
        return false;
      const operation = input.operations[Number(match[1])];
      if (!operation || typeof operation !== 'object') return false;
      return match[2] === 'value'
        ? operation.type === 'insert' || operation.type === 'patch'
        : operation.type === 'increment';
    },
    prepareArguments: (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('Data Table tool arguments must be an object.');
      }
      if ('cursor' in args) {
        z.object({ cursor: queryAppDataTableCursorSchema.optional() }).parse(
          args,
        );
      }
      return args;
    },
    description:
      "Inspect, query, or mutate a deployed app's managed Data Tables. " +
      'Always prefer the structured inspect, query, and mutate actions. ' +
      'raw_sql is a dangerous last resort only when the structured actions ' +
      'cannot express the required joins, aggregates, or complex data repair. ' +
      'raw_sql may only query or modify rows with SELECT, INSERT, UPDATE, ' +
      'DELETE, MERGE, CTEs, joins, aggregates, or upserts. Never use raw_sql ' +
      'for DDL, TRUNCATE, maintenance, transaction control, permissions, ' +
      'roles, databases, or any _hatch object. This is an instruction, not a ' +
      'runtime SQL restriction. Raw SQL bypasses managed validation and may ' +
      'contain multiple statements; unqualified tables resolve in data then ' +
      'public. timeout_ms controls the Raw SQL database operation only; it ' +
      'does not cover App resolution or capability preflight and defaults to ' +
      '30000.',
    // Keep the root object-shaped: the Anthropic adapter forwards root
    // properties/required fields and would discard a root anyOf schema.
    parameters: z.object({
      id: z.string().describe('App id.'),
      action: z.union([
        z.literal('inspect'),
        z.literal('query'),
        z.literal('mutate'),
        z.literal('raw_sql'),
      ]),
      table: z
        .string()
        .min(1)
        .describe(
          'Inspect: optional table to inspect. Query: required table name.',
        )
        .optional(),
      where: z
        .array(
          z.object({
            field: z.string().min(1),
            op: z.union([
              z.literal('eq'),
              z.literal('ne'),
              z.literal('gt'),
              z.literal('gte'),
              z.literal('lt'),
              z.literal('lte'),
              z.literal('in'),
            ]),
            value: z
              .any()
              .describe(
                'JSON value to compare; use an array with the in operator.',
              ),
          }),
        )
        .max(16)
        .describe('Query only: AND-combined filters.')
        .optional(),
      order_by: z
        .object({
          field: z.string().min(1),
          direction: z.union([z.literal('asc'), z.literal('desc')]).optional(),
        })
        .describe('Query only: sort field and direction.')
        .optional(),
      cursor: z
        .string()
        .max(QUERY_APP_DATA_TABLE_CURSOR_MAX_LENGTH)
        .describe('Query only: cursor returned by the previous call.')
        .optional(),
      limit: z
        .int()
        .min(1)
        .max(200)
        .describe('Query only: maximum rows. Defaults to 50.')
        .optional(),
      operations: z
        .array(
          z.object({
            type: z.union([
              z.literal('insert'),
              z.literal('patch'),
              z.literal('increment'),
              z.literal('delete'),
            ]),
            table: z.string().min(1),
            id: z.string().min(1).optional(),
            value: z
              .record(z.string(), z.any())
              .describe('Insert or patch field values.')
              .optional(),
            unset: z
              .array(z.string().min(1))
              .describe('Patch only: optional fields to clear.')
              .optional(),
            field: z
              .string()
              .min(1)
              .describe('Increment only: numeric field name.')
              .optional(),
            amount: z
              .number()
              .describe('Increment only: finite amount to add.')
              .optional(),
          }),
        )
        .min(1)
        .max(100)
        .describe('Mutate only: atomic operations; any failure rolls back all.')
        .optional(),
      sql: z
        .string()
        .min(1)
        .describe(
          'raw_sql only: SQL for querying or modifying existing rows. ' +
            'Never use DDL, TRUNCATE, maintenance, transaction control, or ' +
            '_hatch objects. Physical system columns use created_at and ' +
            'updated_at.',
        )
        .optional(),
      timeout_ms: z
        .int()
        .min(1_000)
        .max(1_800_000)
        .describe(
          'raw_sql only: timeout for the Raw SQL database operation, ' +
            'including statement execution, in milliseconds. It does not ' +
            'cover App resolution or capability preflight. Defaults to 30000.',
        )
        .optional(),
    }),
    execute: async (_id, params, signal) => {
      requireIdSlug(params.id);
      const {
        id,
        order_by: orderBy,
        timeout_ms: timeoutMs,
        ...rawInput
      } = params;
      // The provider-facing schema must stay object-rooted. Apply the strict
      // action-specific contract after translating its snake_case fields.
      const input = queryAppDataTableRequestSchema.parse({
        ...rawInput,
        ...(orderBy === undefined ? {} : { orderBy }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      const res = await platform.queryAppDataTable(id, input, signal);
      switch (res.action) {
        case 'inspect':
          if (!res.data) {
            return text(`App "${id}" has no live Data Table schema.`, res);
          }
          return text(
            JSON.stringify(res.data, null, 2) +
              (res.data.truncated
                ? '\nThe full schema exceeded the output budget. Inspect ' +
                  'individual tables by passing a table name from ' +
                  'data/schema.ts.'
                : ''),
            res,
          );
        case 'query': {
          if (res.items.length === 0) {
            return text(
              input.action === 'query' && input.cursor
                ? `No Data Table rows found after the provided cursor. Revision: ${res.revision}.`
                : `The Data Table query returned no rows. Revision: ${res.revision}.`,
              res,
            );
          }
          const continuation = res.cursor
            ? `\nContinue with cursor: ${JSON.stringify(res.cursor)}`
            : '';
          const truncation = res.truncated
            ? '\nOutput was truncated. Continue with the returned cursor.'
            : '';
          return text(
            `${JSON.stringify(res.items, null, 2)}\nRevision: ${res.revision}.` +
              `${continuation}${truncation}`,
            res,
          );
        }
        case 'mutate': {
          const missing = res.results.flatMap((result, index) =>
            result === null ? [index + 1] : [],
          );
          return text(
            `${JSON.stringify(res.results, null, 2)}\nRevision: ${res.revision}.` +
              (missing.length > 0
                ? `\nNo row was found for operation(s): ${missing.join(', ')}.`
                : ''),
            res,
          );
        }
        case 'raw_sql':
          return text(
            JSON.stringify(res.results, null, 2) +
              (res.truncated
                ? '\nOutput was truncated. Rerun raw_sql with narrower ' +
                  'columns, LIMIT, keyset conditions, or SQL substring ' +
                  'functions.'
                : ''),
            res,
          );
      }
    },
  });

  return [
    listAppsTool,
    getAppTool,
    checkoutAppTool,
    createAppTool,
    deployAppTool,
    rollbackAppTool,
    queryAppDb,
    queryAppKv,
    queryAppDataTable,
  ];
}
