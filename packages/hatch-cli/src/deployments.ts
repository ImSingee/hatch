/** App deployments: list, inspect, follow the log of, and cancel. */
import { parseArgs } from 'node:util';
import { configPath, resolveCredential } from './config';
import { type DeploymentView, platformClient } from './client';
import { CliError, argumentsError } from './error';
import { followDeployment } from './lifecycle';

const ACTIONS = ['list', 'get', 'logs', 'cancel'] as const;
type Action = (typeof ACTIONS)[number];

export type DeploymentsCommand = {
  action: Action;
  id: string;
  deploymentId?: string;
  limit?: number;
  cursor?: number;
  after: number;
  follow: boolean;
  json: boolean;
  timeoutMs: number;
  config?: string;
  profile?: string;
};

function invalid(message: string): CliError {
  return new CliError('invalid_arguments', message);
}

/** Validate arguments locally; nothing is sent until this succeeds. */
export function parseDeploymentsCommand(
  args: readonly string[],
  offset: number,
): DeploymentsCommand {
  const action = args[offset + 2] as Action | undefined;
  if (!action || !ACTIONS.includes(action))
    throw invalid(
      'Use hatch app deployments list, get, logs or cancel. See hatch help app deployments.',
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
        limit: { type: 'string' },
        cursor: { type: 'string' },
        after: { type: 'string' },
        follow: { type: 'boolean' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw argumentsError(error, `app deployments ${action}`);
  }
  const v = parsed.values;
  const positionals = parsed.positionals;
  const arity = action === 'list' ? 1 : 2;
  if (positionals.length !== arity || positionals.some((p) => !p))
    throw invalid(
      action === 'list'
        ? 'Supply exactly one App ID or slug to deployments list.'
        : `Supply an App ID or slug and a deployment ID to deployments ${action}.`,
    );
  const only = (flags: string[], allowed: Action) => {
    for (const flag of flags)
      if (v[flag as keyof typeof v] !== undefined && action !== allowed)
        throw invalid(`--${flag} applies only to deployments ${allowed}.`);
  };
  only(['limit', 'cursor'], 'list');
  only(['after', 'follow'], 'logs');
  const integer = (
    value: string | undefined,
    flag: string,
    min: number,
    max: number,
  ) => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!/^[0-9]+$/.test(value) || number < min || number > max)
      throw invalid(`--${flag} must be an integer between ${min} and ${max}.`);
    return number;
  };
  const limit = integer(v.limit, 'limit', 1, 100);
  const cursor = integer(v.cursor, 'cursor', 1, 2 ** 31);
  const after = integer(v.after, 'after', 0, 2 ** 31) ?? 0;
  const defaultSeconds = v.follow ? 1800 : 30;
  const seconds = v.timeout === undefined ? defaultSeconds : Number(v.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.profile)
  )
    throw invalid('Invalid profile name.');
  if (v.config === '') throw invalid('--config must not be empty.');
  return {
    action,
    id: positionals[0],
    deploymentId: positionals[1],
    limit,
    cursor,
    after,
    follow: v.follow === true,
    json: v.json === true,
    timeoutMs: Math.ceil(seconds * 1000),
    config: v.config,
    profile: v.profile,
  };
}

/** One line per deployment with every identifier a follow-up command needs. */
export function deploymentText(deployment: DeploymentView): string {
  return [
    deployment.deploymentId,
    deployment.status,
    `build=${deployment.build}`,
    `commit=${deployment.commit.slice(0, 12)}`,
    ...('version' in deployment && deployment.version !== undefined
      ? [`version=${deployment.version}`]
      : []),
    ...(deployment.errorCode ? [`error=${deployment.errorCode}`] : []),
    deployment.createdAt,
    JSON.stringify(deployment.message),
  ].join('  ');
}

export async function runDeployments(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const command = parseDeploymentsCommand(args, offset);
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, command.config),
    command.profile,
  );
  const { deployments } = platformClient(
    credential,
    command.timeoutMs,
    signal,
  ).apps;
  const write = (json: unknown, text: string) =>
    process.stdout.write(
      command.json ? `${JSON.stringify(json)}\n` : `${text}\n`,
    );
  if (command.action === 'list') {
    const page = await deployments.list({
      id: command.id,
      limit: command.limit,
      cursor: command.cursor,
    });
    write(
      page,
      [
        ...page.deployments.map(deploymentText),
        ...(page.nextCursor === null ? [] : [`nextCursor: ${page.nextCursor}`]),
      ].join('\n') || 'No deployments.',
    );
    return;
  }
  const target = { id: command.id, deploymentId: command.deploymentId! };
  if (command.action === 'get') {
    const deployment = await deployments.get(target);
    write(deployment, deploymentText(deployment));
    return;
  }
  if (command.action === 'cancel') {
    const deployment = await deployments.cancel(target);
    write(deployment, deploymentText(deployment));
    return;
  }
  // logs: print every line after --after; --follow waits for new ones until
  // the deployment finishes.
  if (command.follow) {
    const deployment = await followDeployment(deployments, {
      ...target,
      afterSeq: command.after,
      deadline: Date.now() + command.timeoutMs,
    });
    write(deployment, deploymentText(deployment));
    return;
  }
  const lines = [];
  let state: DeploymentView | null = null;
  // Without --follow: every line up to the deployment's log as it stood at
  // the first response (several responses for a long log), then stop
  // without waiting for more.
  let snapshot: number | null = null;
  for await (const message of deployments.watch(
    { ...target, afterSeq: command.after },
    { timeoutMs: command.timeoutMs },
  )) {
    lines.push(...message.lines);
    if (message.deployment) state = message.deployment;
    snapshot ??= state?.logSeq ?? 0;
    const last = lines.at(-1)?.seq ?? command.after;
    if (last >= snapshot) break;
  }
  write(
    { deployment: state, lines },
    lines.map((line) => line.text).join('\n'),
  );
}
