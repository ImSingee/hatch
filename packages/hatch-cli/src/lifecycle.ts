import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { mkdtemp, rename, writeFile, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configPath, resolveCredential } from './config';
import { platformClient } from './client';
import { argumentsError, CliError } from './error';
import {
  assertAbsent,
  assertReplacementSafe,
  checkoutView,
  canonicalTarget,
  clean,
  configureOrigin,
  fetchRemote,
  git,
  installSdk,
  pushHead,
  safeTree,
  saveWorkspace,
  writeFiles,
  withWorkspaceLock,
  workspace,
} from './workspace';
import type { Workspace } from './workspace';
import { readInput } from './input';
import { isValidAppSlug } from '../../hatch-manifest/src/app-schema.js';
import { adopt } from './adopt';
import { refreshRunEnvironment } from './run-credential';
import type { DeploymentView } from './client';
import { buildLocally, localBuildTooling } from './local-build';

/**
 * How long after its deadline a create request is still taken to be able
 * to land (clock skew, the commit in flight).
 */
const CREATE_SETTLE_GRACE_MS = 60_000;

export async function runLifecycle(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const operation = args[offset + 1];
  if (!operation)
    throw new CliError(
      'invalid_arguments',
      'Supply a lifecycle subcommand. Use hatch help.',
    );
  const available = [
    'list',
    'get',
    'create',
    'clone',
    'update',
    'push',
    'deploy',
    'rollback',
    'associate',
    'adopt',
  ];
  if (!available.includes(operation))
    throw new CliError('unknown_command', 'Unknown command. Use hatch help.');
  const common = {
    json: { type: 'boolean' },
    profile: { type: 'string' },
    config: { type: 'string' },
    timeout: { type: 'string' },
    workdir: { type: 'string' },
  } as const;
  const extra: Record<string, { type: 'string' | 'boolean' }> =
    operation === 'create'
      ? { file: { type: 'string' }, directory: { type: 'string' } }
      : operation === 'clone' ||
          operation === 'update' ||
          operation === 'push' ||
          operation === 'adopt'
        ? {
            directory: { type: 'string' },
            ...(operation === 'clone'
              ? { force: { type: 'boolean' as const } }
              : {}),
          }
        : operation === 'deploy'
          ? {
              directory: { type: 'string' },
              message: { type: 'string' },
              commit: { type: 'string' },
              'allow-destructive-data-migration': { type: 'boolean' },
              'data-migration-approval-token': { type: 'string' },
              reconcile: { type: 'boolean' },
              'retry-after-confirming': { type: 'string' },
              local: { type: 'boolean' },
              'no-wait': { type: 'boolean' },
            }
          : operation === 'rollback'
            ? { version: { type: 'string' } }
            : {};
  if (
    operation === 'deploy' &&
    args.some((arg) => arg === '--build' || arg.startsWith('--build='))
  )
    throw new CliError(
      'invalid_arguments',
      '--build was removed. Leave it out to build on the platform Builder (the default), or pass --local to build on this machine and upload the build package.',
    );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 2)],
      options: { ...common, ...extra },
      allowPositionals: true,
    });
  } catch (error) {
    throw argumentsError(error, args[offset] ?? '');
  }
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positional = parsed.positionals;
  const requiresId = [
    'get',
    'clone',
    'rollback',
    'associate',
    'adopt',
  ].includes(operation);
  if (
    positional.length !== (requiresId ? 1 : 0) ||
    (requiresId && (!positional[0] || positional[0].startsWith('-')))
  )
    throw new CliError(
      'invalid_arguments',
      'Supply exactly one ID/slug for get/clone/rollback, and no positional arguments for other commands.',
    );
  const seconds =
    values.timeout === undefined
      ? operation === 'deploy' || operation === 'push'
        ? 600
        : 30
      : Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    values.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(values.profile))
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if (
    [values.config, values.workdir, values.directory].some(
      (value) => value === '',
    )
  )
    throw new CliError('invalid_arguments', 'Paths must not be empty.');
  const timeout = Math.ceil(seconds * 1000);
  // Source transfers get five minutes by default; an explicit --timeout is
  // honored as given.
  const transferTimeout =
    values.timeout === undefined ? Math.max(timeout, 300000) : timeout;
  if (
    values.commit !== undefined &&
    !/^[0-9a-f]{40}$/.test(String(values.commit))
  )
    throw new CliError(
      'invalid_arguments',
      '--commit must be a full 40-character lowercase commit id.',
    );
  if (values.commit !== undefined && values.reconcile)
    throw new CliError(
      'invalid_arguments',
      '--commit cannot be combined with --reconcile.',
    );
  if (values.reconcile && values['retry-after-confirming'] !== undefined)
    throw new CliError(
      'invalid_retry_confirmation',
      '--reconcile only reports the pending deployment; run --retry-after-confirming <commit> on its own.',
    );
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, values.config as string | undefined),
    values.profile as string | undefined,
  );
  // Environment credentials need no file; a profile from --config does.
  const helperConfig =
    credential.source === 'config' && values.config
      ? resolve(String(values.config))
      : undefined;
  const client = platformClient(credential, timeout, signal);
  const api = client.apps;
  const workdir = resolve(String(values.workdir ?? '.'));
  const directory = resolve(workdir, String(values.directory ?? '.'));
  const output = (value: unknown) =>
    process.stdout.write(
      `${JSON.stringify(value, null, values.json ? undefined : 2)}\n`,
    );
  if (operation === 'associate') {
    output(
      await client.apps.associate({ params: { id: positional[0] }, body: {} }),
    );
    return;
  }
  if (operation === 'adopt') {
    if (!values.directory)
      throw new CliError('invalid_arguments', 'Adopt requires --directory.');
    await withWorkspaceLock(directory, async (root) => {
      const metadata = await adopt(
        root,
        positional[0],
        credential,
        client,
        transferTimeout,
        signal,
      );
      output(await checkoutView(root, metadata, signal, { adopted: true }));
    });
    return;
  }
  if (operation === 'list') {
    output(await api.list({}));
    return;
  }
  if (operation === 'get') {
    output(await api.get({ id: positional[0] }));
    return;
  }
  if (operation === 'rollback') {
    const version = Number(values.version);
    if (!Number.isSafeInteger(version) || version < 1)
      throw new CliError(
        'invalid_arguments',
        'Supply --version <positive-integer> for rollback.',
      );
    const result = await api.rollback({
      params: { id: (await api.get({ id: positional[0] })).id },
      body: { version },
    });
    output({
      ...result,
      warnings: [
        ...(!result.compatibility.isSupported
          ? [
              'Restored source uses unsupported compatibility; runtime is disabled until source or platform is updated.',
            ]
          : []),
        ...('dataSchemaMismatch' in result && result.dataSchemaMismatch
          ? [
              'Data schemas are forward-only. Restored source differs from the active schema; retained data was not rolled back.',
            ]
          : []),
      ],
      sourceRecovery:
        'Platform master now points at the restored version. Existing checkouts are unchanged: commits made after that version stay local and can be pushed or deployed again, or reverted first if they should not return.',
    });
    return;
  }
  if (operation === 'create' || operation === 'clone') {
    const input =
      operation === 'create'
        ? await readInput(
            values.file === '-'
              ? '-'
              : values.file
                ? resolve(workdir, String(values.file))
                : '',
            signal,
          )
        : null;
    if (
      input &&
      (typeof input.slug !== 'string' || !isValidAppSlug(input.slug))
    )
      throw new CliError(
        'invalid_input',
        'Create input requires a slug of at most 64 characters using lowercase ' +
          'letters, digits, and hyphens, starting with a letter or digit.',
      );
    const detail =
      operation === 'clone' ? await api.get({ id: positional[0] }) : null;
    const target = await canonicalTarget(
      resolve(workdir, String(values.directory ?? input?.slug ?? detail?.slug)),
    );
    await withWorkspaceLock(target, async (root) => {
      if (values.force && !values.directory)
        throw new CliError(
          'invalid_arguments',
          '--force requires an explicit --directory.',
        );
      if (values.force) await assertReplacementSafe(root, workdir);
      else await assertAbsent(root);
      const replaced = Boolean(await lstat(root).catch(() => null));
      const stage = await mkdtemp(join(dirname(root), '.hatch-cli-stage-'));
      let recovery = stage;
      try {
        await git(stage, signal, ['init', '-b', 'master']);
        await writeFile(
          join(stage, '.git', 'hatch-recovery.json'),
          JSON.stringify({
            command: operation,
            url: credential.url,
            requested: input ?? positional[0],
            startedAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        );
        let metadata: Workspace;
        if (operation === 'create') {
          // The platform validates this request against the Protobuf contract.
          const created = await client.apps.create(
            input as Parameters<typeof client.apps.create>[0],
          );
          await writeFile(
            join(stage, '.git', 'hatch-create.json'),
            JSON.stringify(created),
            { mode: 0o600 },
          );
          await writeFiles(stage, created.files);
          await git(stage, signal, ['add', '.']);
          await git(stage, signal, [
            '-c',
            'user.name=Hatch CLI',
            '-c',
            'user.email=cli@hatch.local',
            '-c',
            'commit.gpgSign=false',
            'commit',
            '-m',
            'Initialize scaffold',
          ]);
          const row = await api.get({ id: created.id });
          metadata = {
            version: 1,
            kind: 'app',
            url: credential.url,
            id: created.id,
            generation: row.createdAt,
            masterCommit: null,
          };
        } else {
          const commit = await fetchRemote(
            stage,
            credential,
            detail!.id,
            transferTimeout,
            signal,
          );
          if (
            (await api.get({ id: detail!.id })).createdAt !== detail!.createdAt
          )
            throw new CliError(
              'RESOURCE_GENERATION_CONFLICT',
              'Resource generation changed during clone; checkout was retained.',
              6,
            );
          if (commit)
            await git(stage, signal, ['checkout', '-B', 'master', commit]);
          metadata = {
            version: 1,
            kind: 'app',
            url: credential.url,
            id: detail!.id,
            generation: detail!.createdAt,
            masterCommit: commit,
          };
        }
        await configureOrigin(
          stage,
          credential,
          metadata.id,
          signal,
          helperConfig,
        );
        await saveWorkspace(stage, metadata);
        // Tool checkout associates the App even if source preparation fails.
        const association = await client.apps.associate({
          params: { id: metadata.id },
          body: {},
        });
        // Prepare before touching an existing directory. A failed fresh/empty
        // checkout is retained at its requested path for source repair.
        if (!replaced) {
          await assertAbsent(root);
          await rename(stage, root);
          recovery = root;
        }
        await installSdk(recovery, credential, timeout, signal);
        if (replaced) {
          await assertReplacementSafe(root, workdir);
          const backup = `${stage}-previous`;
          await rename(root, backup);
          try {
            await rename(stage, root);
            recovery = root;
          } catch (error) {
            try {
              await rename(backup, root);
            } catch {
              throw new CliError(
                'replacement_restore_failed',
                `Replacement target changed during swap. Previous directory was retained at ${backup}; prepared checkout is at ${stage}. Recover explicitly before retrying.`,
                6,
              );
            }
            throw error;
          }
          await rm(backup, { recursive: true, force: true });
        }
        output(
          await checkoutView(root, metadata, signal, {
            slug: input?.slug ?? detail?.slug,
            replacedExisting: replaced,
            dependenciesInstalled: true,
            association: association.association,
          }),
        );
      } catch (error) {
        // Preserve the actual template/checkout and local journal for recovery.
        const cause =
          error instanceof CliError
            ? error
            : new CliError(
                'workspace_preparation_failed',
                'Creation/clone/preparation failed. Inspect remote state; do not blindly create again.',
                7,
              );
        throw new CliError(
          cause.code,
          `${cause.message} Recovery workspace: ${recovery}`,
          cause.exitCode,
        );
      }
    });
    return;
  }
  await withWorkspaceLock(directory, async (root) => {
    const metadata = await workspace(root, credential);
    const detail = await api.get({ id: metadata.id });
    if (detail.id !== metadata.id || detail.createdAt !== metadata.generation)
      throw new CliError(
        'RESOURCE_GENERATION_CONFLICT',
        'Resource was deleted/recreated. Clone into a new directory; local work was retained.',
        6,
      );
    // The checkout's pending deployment as the platform records it: by the
    // deployment id once known, else by the request id the create sent.
    const lookupPending = async (
      pending: NonNullable<Workspace['pending']>,
    ) => {
      // The platform answers for the moment the lookup was sent: a create
      // that landed after that is not in the answer.
      const sentAt = Date.now();
      const found = pending.deploymentId
        ? await api.deployments
            .get({ id: metadata.id, deploymentId: pending.deploymentId })
            .catch((error: unknown) => {
              if (error instanceof CliError && error.exitCode === 5)
                return null;
              throw error;
            })
        : pending.requestId
          ? ((
              await api.deployments.list({
                id: metadata.id,
                requestId: pending.requestId,
              })
            ).deployments[0] ?? null)
          : null;
      // Nothing found is taken as final once the create request's deadline
      // and a grace period have passed: the platform creates nothing for a
      // call that ended before it commits. A known deployment the platform
      // no longer has is missing, which no wait settles.
      const state = found
        ? found.finished
          ? 'finished'
          : 'in-progress'
        : pending.deploymentId
          ? 'missing'
          : !!pending.requestId &&
              sentAt >
                Date.parse(pending.createDeadline ?? pending.startedAt) +
                  CREATE_SETTLE_GRACE_MS
            ? 'not-created'
            : 'unconfirmed';
      return { found, state };
    };
    // --reconcile only reads the platform record, so local edits made while
    // the deployment runs do not block it, and it associates nothing.
    if (operation === 'deploy' && values.reconcile) {
      const pending = metadata.pending;
      if (!pending)
        throw new CliError(
          'no_pending_deployment',
          'No pending deployment to reconcile.',
        );
      const { found, state } = await lookupPending(pending);
      // A settled deployment is reported once the checkout has forgotten it.
      if (state === 'finished' || state === 'not-created') {
        delete metadata.pending;
        await saveWorkspace(root, metadata);
      }
      output({ id: metadata.id, state, pending, deployment: found ?? null });
      return;
    }
    await client.apps.associate({ params: { id: metadata.id }, body: {} });
    await configureOrigin(root, credential, metadata.id, signal, helperConfig);
    // A plain push or a deploy of an already pushed commit never reads the
    // working tree, so uncommitted work does not block it.
    if (operation === 'update' || (operation === 'deploy' && !values.commit))
      await clean(root, signal);
    const localHead = await git(
      root,
      signal,
      ['rev-parse', '--verify', 'HEAD'],
      true,
    );
    const head = localHead.code === 0 ? localHead.stdout : null;
    if (head) await safeTree(root, signal);
    if (operation === 'update') {
      const remote = await fetchRemote(
        root,
        credential,
        metadata.id,
        transferTimeout,
        signal,
      );
      if (
        (await api.get({ id: metadata.id })).createdAt !== metadata.generation
      )
        throw new CliError(
          'RESOURCE_GENERATION_CONFLICT',
          'Resource generation changed during update; local source was preserved.',
          6,
        );
      if (!remote && metadata.masterCommit === null) {
        await installSdk(root, credential, timeout, signal);
        output(
          await checkoutView(root, metadata, signal, {
            state: 'draft-prepared',
            synchronizedExisting: true,
          }),
        );
        return;
      }
      if (!remote)
        throw new CliError(
          'source_empty',
          'Platform master is empty. Local work was preserved.',
          6,
        );
      if (
        (await git(root, signal, ['symbolic-ref', '--short', 'HEAD']))
          .stdout !== 'master'
      )
        throw new CliError(
          'branch_mismatch',
          'Update requires local master; source was preserved.',
          6,
        );
      const contains = async (ancestor: string, descendant: string) =>
        (
          await git(
            root,
            signal,
            ['merge-base', '--is-ancestor', ancestor, descendant],
            true,
          )
        ).code === 0;
      // Local commits on top of platform master are unpushed work, or work a
      // rollback moved master away from. Nothing to merge; push when ready.
      const ahead = !!head && head !== remote && (await contains(remote, head));
      if (head && head !== remote && !ahead) {
        if (!(await contains(head, remote)))
          throw new CliError(
            'non_fast_forward',
            'Local and platform history diverged. Platform history was fetched into origin/master; explicitly merge/rebase your work before retrying. No source was reset.',
            6,
          );
        await git(root, signal, ['merge', '--ff-only', remote]);
      }
      if (!head) await git(root, signal, ['merge', '--ff-only', remote]);
      metadata.masterCommit = remote;
      await saveWorkspace(root, metadata);
      await installSdk(root, credential, timeout, signal);
      output(
        await checkoutView(root, metadata, signal, {
          state:
            head === remote ? 'current' : ahead ? 'ahead' : 'fast-forwarded',
          synchronizedExisting: true,
        }),
      );
      return;
    }
    const push = async (commit: string) => {
      const state = await pushHead(
        root,
        credential,
        metadata.id,
        timeout,
        signal,
      );
      metadata.masterCommit = commit;
      await saveWorkspace(root, metadata);
      return state;
    };
    if (operation === 'push') {
      if (!head)
        throw new CliError('source_empty', 'Commit source before pushing.', 6);
      const state = await push(head);
      output({ id: metadata.id, commit: head, masterCommit: head, state });
      return;
    }
    if (metadata.pending && values['retry-after-confirming']) {
      if (values['retry-after-confirming'] !== metadata.pending.commit)
        throw new CliError(
          'invalid_retry_confirmation',
          'Confirm the exact pending commit after inspecting the deployment with hatch app deployments list.',
        );
      await writeFile(
        join(root, '.git', 'hatch-deploy-confirmations.jsonl'),
        JSON.stringify({
          ...metadata.pending,
          confirmedAt: new Date().toISOString(),
        }) + '\n',
        { flag: 'a', mode: 0o600 },
      );
      delete metadata.pending;
      await saveWorkspace(root, metadata);
    }
    if (metadata.pending) {
      // The platform records every deployment, so a deploy this checkout
      // lost track of is settled from its state rather than guessed.
      const pending = metadata.pending;
      // Only the platform's own record of this create request settles it.
      const { found, state } = await lookupPending(pending);
      if (found && !found.finished)
        throw new CliError(
          'deployment_in_progress',
          `Deployment ${found.deploymentId} of ${found.commit} is still ${found.status}. Follow it with hatch app deployments logs ${metadata.id} ${found.deploymentId} --follow, or cancel it with hatch app deployments cancel ${metadata.id} ${found.deploymentId} --yes.`,
          6,
          undefined,
          { deployment: found },
        );
      if (state === 'missing')
        throw new CliError(
          'pending_deployment_missing',
          `The platform has no deployment ${pending.deploymentId}, which the deploy of ${pending.commit} started at ${pending.startedAt} created; waiting will not settle it. Inspect hatch app deployments list ${metadata.id}, then retry with --retry-after-confirming ${pending.commit}.`,
          6,
          undefined,
          { pending },
        );
      if (state === 'unconfirmed')
        throw new CliError(
          'deployment_in_progress',
          pending.requestId
            ? `The deploy of ${pending.commit} started at ${pending.startedAt} may still be created. Run hatch app deploy --reconcile after ${new Date(Date.parse(pending.createDeadline ?? pending.startedAt) + CREATE_SETTLE_GRACE_MS).toISOString()}.`
            : `The platform cannot tell whether the deploy of ${pending.commit} started at ${pending.startedAt} was created. Inspect hatch app deployments list ${metadata.id}, then retry with --retry-after-confirming ${pending.commit}.`,
          6,
          undefined,
          { pending },
        );
      if (found?.status === 'ready')
        metadata.lastDeployment = {
          version: found.version as number,
          deploymentId: found.deploymentId,
        };
      delete metadata.pending;
      await saveWorkspace(root, metadata);
    }
    const approved = values['allow-destructive-data-migration'] === true;
    const approval = values['data-migration-approval-token'];
    if (approved !== (typeof approval === 'string' && !!approval))
      throw new CliError(
        'invalid_approval',
        'App destructive approval requires both --allow-destructive-data-migration and the exact --data-migration-approval-token.',
      );
    const requested =
      values.commit === undefined ? null : String(values.commit);
    if (!requested && !head)
      throw new CliError('source_empty', 'Commit source before deployment.', 6);
    // Source first: deploy pushes HEAD, then deploys the pushed commit.
    // --commit deploys a commit that is already on platform master.
    const commit = requested ?? head!;
    // A local build reads the commit from this checkout without fetching:
    // one that is not here fails before any deployment is created.
    if (requested && values.local) {
      const present =
        (
          await git(
            root,
            signal,
            ['cat-file', '-e', `${requested}^{commit}`],
            true,
          )
        ).code === 0;
      if (!present)
        throw new CliError(
          'source_unavailable',
          `Commit ${requested} is not in this checkout, so it cannot be built here. Run hatch app update first, or leave out --local to build it on the platform Builder. No deployment was created.`,
          6,
        );
    }
    const pushed = requested ? null : await push(commit);
    // A long push can outlive a Run token; take a fresh one for the release.
    // The client renews it itself before any later request it would not
    // outlive (a long local build, a follow, a reconnect).
    await refreshRunEnvironment(process.env, signal);
    const releaseClient = platformClient(
      await resolveCredential(
        process.env,
        configPath(process.env, values.config as string | undefined),
        values.profile as string | undefined,
      ),
      timeout,
      signal,
    );
    const deployments = releaseClient.apps.deployments;
    const startedAt = Date.now();
    metadata.pending = {
      command: 'deploy',
      commit,
      startedAt: new Date(startedAt).toISOString(),
      requestId: randomUUID(),
      // The create call's deadline is the client timeout.
      createDeadline: new Date(startedAt + timeout).toISOString(),
    };
    await saveWorkspace(root, metadata);
    let created;
    try {
      created = await deployments.create({
        id: metadata.id,
        message: String(values.message ?? 'Deploy from Hatch CLI'),
        generation: metadata.generation,
        commit,
        // The platform Builder unless asked to build here.
        build: values.local ? 'local' : 'builder',
        requestId: metadata.pending.requestId,
        // Nobody follows a --no-wait deployment: the platform says how it ends.
        ...(values['no-wait'] ? { notify: true } : {}),
        ...(approved
          ? {
              allowDestructiveDataMigration: true,
              dataMigrationApprovalToken: String(approval),
            }
          : {}),
      });
    } catch (error) {
      // A definite 4xx response is a rejected deployment, and is safe to fix/retry.
      if (isRejected(error)) {
        delete metadata.pending;
        await saveWorkspace(root, metadata);
      }
      throw error;
    }
    metadata.pending.deploymentId = created.deploymentId;
    await saveWorkspace(root, metadata);
    process.stderr.write(
      `Deployment ${created.deploymentId} of ${commit} (${created.build} build): ${created.status}\n`,
    );
    const deadline = Date.now() + timeout;
    const follow = (options: {
      afterSeq: number;
      platformOnly: boolean;
      signal?: AbortSignal;
    }) =>
      followDeployment(deployments, {
        id: metadata.id,
        deploymentId: created.deploymentId,
        deadline,
        ...options,
      });
    // Follow to the end; a deployment that finished before the rest of its
    // log arrived settles by its outcome.
    const followToEnd = (options: {
      afterSeq: number;
      platformOnly: boolean;
      signal?: AbortSignal;
    }) =>
      follow(options).catch((error: unknown) => {
        if (
          error instanceof CliError &&
          error.code === 'deployment_log_incomplete'
        ) {
          process.stderr.write(`${error.message}\n`);
          return (error.details as { deployment: DeploymentView }).deployment;
        }
        throw error;
      });
    let final = created;
    if (created.build === 'local' && created.status === 'awaiting_artifact') {
      let archive: Buffer;
      try {
        const sdk = await releaseClient.sdk.get();
        archive = await buildLocally({
          root,
          appId: metadata.id,
          deploymentId: created.deploymentId,
          commit,
          sdkFiles: sdk.files,
          tooling: localBuildTooling(sdk.tooling),
          signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
      } catch (error) {
        // Nothing was uploaded: record the failed build (or the cancellation)
        // instead of leaving the deployment waiting for a package.
        const failure =
          error instanceof CliError &&
          ['app_build_failed', 'APP_MANIFEST_INVALID'].includes(error.code)
            ? {
                failureMessage: error.message.slice(0, 64_000),
                failureCode: error.code as
                  | 'app_build_failed'
                  | 'APP_MANIFEST_INVALID',
              }
            : {};
        const settled = await deployments
          .cancel({
            id: metadata.id,
            deploymentId: created.deploymentId,
            ...failure,
          })
          .then(
            () => true,
            () => false,
          );
        // Keep the deployment id while the platform may still be waiting
        // for this package; --reconcile or deployments cancel settles it.
        if (settled) {
          delete metadata.pending;
          await saveWorkspace(root, metadata);
        } else {
          process.stderr.write(
            `Deployment ${created.deploymentId} could not be canceled; cancel it with hatch app deployments cancel ${metadata.id} ${created.deploymentId} --yes.\n`,
          );
        }
        throw error;
      }
      process.stderr.write(
        `Uploading the build package (${(archive.length / 1024 / 1024).toFixed(1)} MB)...\n`,
      );
      // The platform verifies and releases during the upload; show its
      // progress meanwhile. The local build already printed its own output.
      const watch = new AbortController();
      const watching = followToEnd({
        afterSeq: created.logSeq,
        platformOnly: true,
        signal: watch.signal,
      }).then(
        (deployment) => ({ deployment }),
        (error: unknown) => ({ error }),
      );
      try {
        final = await deployments.upload({
          id: metadata.id,
          deploymentId: created.deploymentId,
          artifact: archive,
        });
      } catch (error) {
        watch.abort();
        await watching;
        throw error;
      }
      // --no-wait leaves a release the platform has yet to finish to it.
      if (!final.finished && values['no-wait']) watch.abort();
      const watched = await watching;
      // The platform may hand a release that committed but has yet to
      // finish on to its recovery sweep; the watch followed it to its end.
      if (!final.finished && !values['no-wait']) {
        if ('error' in watched) throw watched.error;
        final = watched.deployment;
      }
    } else if (!created.finished && !values['no-wait']) {
      final = await followToEnd({ afterSeq: 0, platformOnly: false });
    }
    if (!final.finished) {
      // --no-wait: the platform finishes the deployment on its own.
      output({
        ...final,
        id: metadata.id,
        sourceCommit: commit,
        ...(pushed ? { pushState: pushed } : {}),
      });
      return;
    }
    delete metadata.pending;
    if (final.status === 'ready')
      metadata.lastDeployment = {
        version: final.version as number,
        deploymentId: final.deploymentId,
      };
    await saveWorkspace(root, metadata);
    if (final.status !== 'ready')
      throw new CliError(
        final.errorCode ?? 'deployment_failed',
        final.errorMessage ??
          `Deployment ${final.deploymentId} ${final.status}.`,
        // Source the build rejects is an input error; the rest are conflicts.
        ['APP_MANIFEST_INVALID', 'app_build_failed'].includes(
          final.errorCode ?? '',
        )
          ? 2
          : 6,
        undefined,
        { deployment: final },
      );
    output({
      ...final,
      id: metadata.id,
      sourceCommit: commit,
      ...(pushed ? { pushState: pushed } : {}),
    });
  });
}

type DeploymentsClient = ReturnType<
  typeof platformClient
>['apps']['deployments'];

/** What a follow keeps of its budget to read the final state. */
const FINAL_LOOKUP_MS = 5_000;

/**
 * Print a deployment's log to stderr until it finishes, reconnecting after
 * a dropped stream. Returns the finished deployment once its whole log has
 * arrived. Past `deadline` it fails with `deployment_in_progress`, leaving
 * the deployment running, or with `deployment_log_incomplete` (and the
 * finished deployment and the sequence to resume from) when only the rest
 * of its log is missing. Once a finished state is known, a later failure to
 * read the log also ends in `deployment_log_incomplete`, so the caller can
 * settle that outcome; cancellation always ends the follow as it is.
 */
export async function followDeployment(
  deployments: DeploymentsClient,
  options: {
    id: string;
    deploymentId: string;
    afterSeq: number;
    deadline: number;
    platformOnly?: boolean;
    /** Stops following (the caller no longer needs it). */
    signal?: AbortSignal;
  },
): Promise<DeploymentView> {
  let after = options.afterSeq;
  // Set by the stream and the final lookup, the freshest state known.
  let last = null as DeploymentView | null;
  // A terminal status alone is not the end: its log must have arrived too.
  const complete = (state: DeploymentView | null) =>
    !!state?.finished && after >= state.logSeq;
  const canceled = (error: unknown) =>
    !!options.signal?.aborted ||
    (error instanceof CliError && error.exitCode === 130);
  const resume = () =>
    `hatch app deployments logs ${options.id} ${options.deploymentId} --after ${after}`;
  const incomplete = (state: DeploymentView, cause?: unknown) => {
    const code = cause
      ? cause instanceof CliError
        ? cause.code
        : 'internal_error'
      : undefined;
    return new CliError(
      'deployment_log_incomplete',
      `Deployment ${options.deploymentId} is ${state.status}, but its log after line ${after} ${code ? `could not be read (${code})` : 'did not arrive in time'}. Print the rest with ${resume()}.`,
      7,
      undefined,
      { deployment: state, afterSeq: after, ...(code ? { cause: code } : {}) },
    );
  };
  // A failure other than a timeout or cancellation keeps a known outcome.
  const settle = (error: unknown) => {
    if (!canceled(error) && last?.finished) return incomplete(last, error);
    return error;
  };
  /** Stream the log until it is complete or `until` passes. */
  const watch = async (until: number) => {
    const pause = (ms: number) =>
      new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(ms, until - Date.now()))),
      );
    for (;;) {
      options.signal?.throwIfAborted();
      const remaining = until - Date.now();
      if (remaining <= 0) return;
      const before = after;
      try {
        for await (const message of deployments.watch(
          {
            id: options.id,
            deploymentId: options.deploymentId,
            afterSeq: after,
          },
          { timeoutMs: remaining, signal: options.signal },
        )) {
          for (const line of message.lines) {
            after = line.seq;
            if (options.platformOnly && line.stream !== 'platform') continue;
            process.stderr.write(`${line.text}\n`);
          }
          if (message.deployment) {
            if (last && message.deployment.status !== last.status)
              process.stderr.write(`-> ${message.deployment.status}\n`);
            last = message.deployment;
          }
          if (complete(last)) return;
        }
        // The stream ended before the whole log arrived: resume from the
        // last line, after a pause when it brought nothing new.
        if (after === before) await pause(1000);
      } catch (error) {
        // A dropped or timed-out stream (exit 7) resumes from the last line
        // seen; any other failure is the caller's to report.
        if (
          canceled(error) ||
          !(error instanceof CliError) ||
          error.exitCode !== 7
        )
          throw settle(error);
        await pause(1000);
      }
    }
  };
  // The stream stops early enough to leave time to read the final state.
  await watch(
    options.deadline -
      Math.min(
        FINAL_LOOKUP_MS,
        Math.floor((options.deadline - Date.now()) / 4),
      ),
  );
  if (last && complete(last)) return last;
  // The last frame may be older than the deployment: read it with what is
  // left of the budget, keeping the last frame when that times out.
  const left = options.deadline - Date.now();
  if (left > 0)
    last = await deployments
      .get(
        { id: options.id, deploymentId: options.deploymentId },
        { timeoutMs: left, signal: options.signal },
      )
      .catch((error: unknown) => {
        if (
          canceled(error) ||
          !(error instanceof CliError) ||
          error.exitCode !== 7
        )
          throw settle(error);
        return last;
      });
  if (last && complete(last)) return last;
  // Still running, or finished with its log still arriving, with time left:
  // the deadline ends the follow, not the share it kept for the lookup.
  if (options.deadline > Date.now()) {
    await watch(options.deadline);
    if (last && complete(last)) return last;
  }
  if (last?.finished) throw incomplete(last);
  throw new CliError(
    'deployment_in_progress',
    `Deployment ${options.deploymentId} is still ${last?.status ?? 'running'}. Follow it with ${resume()} --follow.`,
    7,
    undefined,
    { deployment: last, afterSeq: after },
  );
}
function isRejected(error: unknown) {
  return (
    error instanceof CliError &&
    !!error.httpStatus &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500
  );
}
