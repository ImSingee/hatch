import { parseArgs } from 'node:util';
import { mkdtemp, rename, writeFile, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { configPath, resolveCredential } from './config';
import { platformClient } from './client';
import { CliError } from './error';
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
import type { Kind, Workspace } from './workspace';
import { readInput } from './input';
import { isValidAppSlug } from '../../hatch-manifest/src/app-schema.js';
import { isValidWorkflowSlug } from '../../hatch-manifest/src/workflow-schema.js';
import { adopt } from './adopt';
import { refreshRunEnvironment } from './run-credential';

export async function runLifecycle(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const kind = args[offset] as Kind;
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
            }
          : operation === 'rollback'
            ? { version: { type: 'string' } }
            : {};
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 2)],
      options: { ...common, ...extra },
      allowPositionals: true,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid arguments. Use hatch help.',
    );
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
  // Fetching source keeps the five-minute allowance local git always had.
  const transferTimeout = Math.max(timeout, 300000);
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
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, values.config as string | undefined),
    values.profile as string | undefined,
  );
  const client = platformClient(credential, timeout, signal);
  const api = kind === 'app' ? client.apps : client.workflows;
  const workdir = resolve(String(values.workdir ?? '.'));
  const directory = resolve(workdir, String(values.directory ?? '.'));
  const output = (value: unknown) =>
    process.stdout.write(
      `${JSON.stringify(value, null, values.json ? undefined : 2)}\n`,
    );
  if (operation === 'associate') {
    if (kind !== 'app')
      throw new CliError(
        'invalid_arguments',
        'Only Apps have session association.',
      );
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
        kind,
        positional[0],
        credential,
        client,
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
    const isValidSlug = kind === 'app' ? isValidAppSlug : isValidWorkflowSlug;
    if (input && (typeof input.slug !== 'string' || !isValidSlug(input.slug)))
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
          const created =
            kind === 'app'
              ? await client.apps.create(
                  input as Parameters<typeof client.apps.create>[0],
                )
              : await client.workflows.create(
                  input as Parameters<typeof client.workflows.create>[0],
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
            kind,
            url: credential.url,
            id: created.id,
            generation: row.createdAt,
            masterCommit: null,
          };
        } else {
          const commit = await fetchRemote(
            stage,
            credential,
            kind,
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
            kind,
            url: credential.url,
            id: detail!.id,
            generation: detail!.createdAt,
            masterCommit: commit,
          };
        }
        await configureOrigin(stage, credential, kind, metadata.id, signal);
        await saveWorkspace(stage, metadata);
        // Tool checkout associates the App even if source preparation fails.
        const association =
          kind === 'app'
            ? await client.apps.associate({
                params: { id: metadata.id },
                body: {},
              })
            : undefined;
        // Prepare before touching an existing directory. A failed fresh/empty
        // checkout is retained at its requested path for source repair.
        if (!replaced) {
          await assertAbsent(root);
          await rename(stage, root);
          recovery = root;
        }
        await installSdk(recovery, kind, credential, timeout, signal);
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
            ...(association ? { association: association.association } : {}),
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
    const metadata = await workspace(root, kind, credential);
    const detail = await api.get({ id: metadata.id });
    if (detail.id !== metadata.id || detail.createdAt !== metadata.generation)
      throw new CliError(
        'RESOURCE_GENERATION_CONFLICT',
        'Resource was deleted/recreated. Clone into a new directory; local work was retained.',
        6,
      );
    if (kind === 'app')
      await client.apps.associate({ params: { id: metadata.id }, body: {} });
    await configureOrigin(root, credential, kind, metadata.id, signal);
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
        kind,
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
        await installSdk(root, kind, credential, timeout, signal);
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
      await installSdk(root, kind, credential, timeout, signal);
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
        kind,
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
      if (
        values.reconcile ||
        values['retry-after-confirming'] !== metadata.pending.commit
      )
        throw new CliError(
          'invalid_retry_confirmation',
          'Confirm the exact pending commit after inspecting platform release history and ensuring the earlier request finished.',
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
      if (values.reconcile) {
        const released = (detail as { currentSourceCommit?: unknown })
          .currentSourceCommit;
        const observed = typeof released === 'string' ? released : null;
        output({
          id: metadata.id,
          state:
            observed === metadata.pending.commit
              ? 'source-matches-pending'
              : 'outcome-unresolved',
          pending: metadata.pending,
          currentSourceCommit: observed,
          note: 'A released commit equal to the pending one does not prove which deployment version released it or that an earlier request has finished. Inspect platform release history before another deploy.',
        });
        return;
      }
      throw new CliError(
        'deployment_outcome_unknown',
        'A previous deployment has an unresolved outcome. Use --reconcile, inspect platform release history, then use --retry-after-confirming <pending-commit> only after confirming that request finished. No automatic retry was made.',
        6,
      );
    }
    if (values.reconcile)
      throw new CliError(
        'no_pending_deployment',
        'No pending deployment to reconcile.',
      );
    const approved = values['allow-destructive-data-migration'] === true;
    const approval = values['data-migration-approval-token'];
    if (
      approved !== (typeof approval === 'string' && !!approval) ||
      (kind === 'workflow' && approved)
    )
      throw new CliError(
        'invalid_approval',
        'App destructive approval requires both --allow-destructive-data-migration and the exact --data-migration-approval-token.',
      );
    const requested =
      values.commit === undefined ? null : String(values.commit);
    if (!requested && !head)
      throw new CliError('source_empty', 'Commit source before deployment.', 6);
    // Deploy is push plus release. --commit releases a commit that is already
    // on platform master, so nothing is pushed.
    const commit = requested ?? head!;
    const pushed = requested ? null : await push(commit);
    // A long push can outlive a Run token; take a fresh one for the release.
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
    metadata.pending = {
      command: 'deploy',
      commit,
      startedAt: new Date().toISOString(),
    };
    await saveWorkspace(root, metadata);
    try {
      const result = await (
        kind === 'app' ? releaseClient.apps : releaseClient.workflows
      ).deploy({
        params: { id: metadata.id },
        body: {
          message: String(values.message ?? 'Deploy from Hatch CLI'),
          generation: metadata.generation,
          commit,
          ...(approved
            ? {
                allowDestructiveDataMigration: true,
                dataMigrationApprovalToken: String(approval),
              }
            : {}),
        },
      });
      metadata.lastDeployment = result;
      delete metadata.pending;
      await saveWorkspace(root, metadata);
      output({
        ...result,
        id: metadata.id,
        sourceCommit: commit,
        ...(pushed ? { pushState: pushed } : {}),
      });
    } catch (error) {
      // A definite 4xx response is a rejected deployment, and is safe to fix/retry.
      if (isRejected(error)) {
        delete metadata.pending;
        await saveWorkspace(root, metadata);
      }
      throw error;
    }
  });
}
function isRejected(error: unknown) {
  return (
    error instanceof CliError &&
    !!error.httpStatus &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500
  );
}
