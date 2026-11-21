/** App backend runtime controls: status, start, graceful or forced stop. */
import { parseArgs } from 'node:util';
import { configPath, resolveCredential } from './config';
import { type AppBackendView, platformClient } from './client';
import { CliError } from './error';

const ACTIONS = ['list', 'status', 'start', 'stop', 'restart'] as const;
type Action = (typeof ACTIONS)[number];

export type BackendCommand = {
  action: Action;
  /** App ID or slug; absent only for list. */
  id?: string;
  force: boolean;
  json: boolean;
  timeoutMs: number;
  config?: string;
  profile?: string;
};

/** Validate arguments locally; nothing is sent until this succeeds. */
export function parseBackendCommand(
  args: readonly string[],
  offset: number,
): BackendCommand {
  const action = args[offset + 2] as Action | undefined;
  if (!action || !ACTIONS.includes(action))
    throw new CliError(
      'invalid_arguments',
      'Use hatch app backend list, status, start, stop or restart.',
    );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        profile: { type: 'string' },
        workdir: { type: 'string' },
        timeout: { type: 'string' },
        force: { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Invalid backend arguments. Use hatch help app backend.',
    );
  }
  const v = parsed.values;
  if (v.force && action !== 'stop' && action !== 'restart')
    throw new CliError(
      'invalid_arguments',
      '--force applies only to backend stop and backend restart.',
    );
  if (action === 'list') {
    if (parsed.positionals.length !== 0)
      throw new CliError(
        'invalid_arguments',
        'backend list takes no App ID. Use backend status <id-or-slug>.',
      );
  } else if (parsed.positionals.length !== 1 || !parsed.positionals[0])
    throw new CliError(
      'invalid_arguments',
      `Supply exactly one App ID or slug to backend ${action}.`,
    );
  const seconds = v.timeout === undefined ? 60 : Number(v.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.profile)
  )
    throw new CliError('invalid_arguments', 'Invalid profile name.');
  if (v.config === '')
    throw new CliError('invalid_arguments', '--config must not be empty.');
  return {
    action,
    id: parsed.positionals[0],
    force: v.force === true,
    json: v.json === true,
    timeoutMs: Math.ceil(seconds * 1000),
    config: v.config,
    profile: v.profile,
  };
}

/** One line per backend with every identifier a follow-up command needs. */
export function backendText(backend: AppBackendView): string {
  const { runtime } = backend;
  const parts = [
    backend.id,
    backend.slug,
    backend.mode,
    runtime.state,
    ...(runtime.pid === null ? [] : [`pid=${runtime.pid}`]),
    ...(runtime.startedAt === null ? [] : [`started=${runtime.startedAt}`]),
    ...(runtime.keepAlive ? ['keep-alive'] : []),
    ...(runtime.drainingInstances > 0
      ? [`draining=${runtime.drainingInstances}`]
      : []),
    ...(runtime.restartCount > 0 ? [`restarts=${runtime.restartCount}`] : []),
    ...(backend.runtimeSupported ? [] : ['unsupported-deployment']),
  ];
  return runtime.lastError === null
    ? parts.join('  ')
    : `${parts.join('  ')}\n  last error: ${runtime.lastError}`;
}

export async function runBackend(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const command = parseBackendCommand(args, offset);
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, command.config),
    command.profile,
  );
  const { backend } = platformClient(
    credential,
    command.timeoutMs,
    signal,
  ).apps;
  if (command.action === 'list') {
    const backends = await backend.list({});
    process.stdout.write(
      command.json
        ? `${JSON.stringify(backends)}\n`
        : `${backends.map((item) => backendText(item)).join('\n') || 'No App backends.'}\n`,
    );
    return;
  }
  const params = { id: command.id as string };
  const result =
    command.action === 'status'
      ? await backend.get({ params })
      : command.action === 'start'
        ? await backend.start({ params })
        : command.action === 'stop'
          ? await backend.stop({ params, force: command.force })
          : await backend.restart({ params, force: command.force });
  process.stdout.write(
    command.json ? `${JSON.stringify(result)}\n` : `${backendText(result)}\n`,
  );
}
