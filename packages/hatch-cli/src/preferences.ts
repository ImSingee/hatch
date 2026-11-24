/** Personal preference commands (`hatch preferences get|set`). */
import { parseArgs } from 'node:util';
import { platformClient } from './client';
import { configPath, resolveCredential } from './config';
import { CliError } from './error';

export const AGENT_MESSAGE_MODES = ['queue', 'steer'] as const;
export type AgentMessageMode = (typeof AGENT_MESSAGE_MODES)[number];
export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type Flags = Record<string, string | boolean | undefined>;
const invalid = (message: string) => new CliError('invalid_arguments', message);

export type DefaultModel = {
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

export type PreferencesCommand =
  | { kind: 'get' }
  | {
      kind: 'set';
      agentMessageMode?: AgentMessageMode;
      defaultModel?: DefaultModel;
      clearDefaultModel?: true;
    };

const GLOBALS = {
  json: { type: 'boolean' },
  config: { type: 'string' },
  profile: { type: 'string' },
  workdir: { type: 'string' },
  timeout: { type: 'string' },
} as const;
const SET_OPTIONS = {
  'agent-message-mode': { type: 'string' },
  'default-model': { type: 'string' },
  thinking: { type: 'string' },
  'clear-default-model': { type: 'boolean' },
} as const;

/**
 * `<provider-id>:<model-id>`. Provider ids never contain ':', while model ids
 * may (and may contain '/'), so only the first ':' separates them.
 */
export function parseDefaultModel(value: string) {
  const index = value.indexOf(':');
  const providerId = index === -1 ? '' : value.slice(0, index);
  const modelId = index === -1 ? '' : value.slice(index + 1);
  if (
    !providerId ||
    !modelId ||
    providerId.length > 191 ||
    modelId.length > 200 ||
    /\s/.test(value)
  )
    throw invalid(
      '--default-model must be <provider-id>:<model-id>, with the provider id and the model id model list prints.',
    );
  return { providerId, modelId };
}

/** Map argv to one command; rejects anything ambiguous before any RPC. */
export function parsePreferencesCommand(
  args: readonly string[],
  offset: number,
): { command: PreferencesCommand; flags: Flags } {
  const operation = args[offset + 1];
  if (operation !== 'get' && operation !== 'set')
    throw invalid('Use hatch preferences get or hatch preferences set.');
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 2)],
      options: { ...GLOBALS, ...(operation === 'set' ? SET_OPTIONS : {}) },
      allowPositionals: true,
      tokens: true,
    });
  } catch {
    throw invalid('Invalid arguments. Use hatch help.');
  }
  if (parsed.positionals.length > 0)
    throw invalid('This command takes no positional arguments.');
  const flags = parsed.values as Flags;
  if (operation === 'get') return { command: { kind: 'get' }, flags };
  for (const name of ['agent-message-mode', 'default-model', 'thinking']) {
    const values = new Set(
      (parsed.tokens ?? []).flatMap((token) =>
        token.kind === 'option' && token.name === name ? [token.value] : [],
      ),
    );
    if (values.size > 1) throw invalid(`Supply --${name} only once.`);
  }
  const mode = flags['agent-message-mode'];
  const model = flags['default-model'];
  const thinking = flags.thinking;
  const clear = flags['clear-default-model'] === true;
  if (thinking !== undefined && model === undefined)
    throw invalid(
      '--thinking applies to --default-model; supply both, or neither.',
    );
  if (mode === undefined && model === undefined && !clear)
    throw invalid(
      'Supply --agent-message-mode queue|steer, --default-model <provider-id>:<model-id> or --clear-default-model.',
    );
  if (
    mode !== undefined &&
    !(AGENT_MESSAGE_MODES as readonly unknown[]).includes(mode)
  )
    throw invalid('--agent-message-mode must be queue or steer.');
  if (model !== undefined && clear)
    throw invalid(
      'Supply at most one of --default-model and --clear-default-model.',
    );
  if (
    thinking !== undefined &&
    !(THINKING_LEVELS as readonly unknown[]).includes(thinking)
  )
    throw invalid(`--thinking must be one of: ${THINKING_LEVELS.join(', ')}.`);
  return {
    command: {
      kind: 'set',
      ...(mode === undefined
        ? {}
        : { agentMessageMode: mode as AgentMessageMode }),
      ...(model === undefined
        ? {}
        : {
            defaultModel: {
              ...parseDefaultModel(String(model)),
              ...(thinking === undefined
                ? {}
                : { thinkingLevel: thinking as ThinkingLevel }),
            },
          }),
      ...(clear ? { clearDefaultModel: true as const } : {}),
    },
    flags,
  };
}

export async function runPreferences(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parsePreferencesCommand(args, offset);
  const seconds = flags.timeout === undefined ? 60 : Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    flags.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(flags.profile))
  )
    throw invalid('Invalid profile name.');
  if (flags.config === '') throw invalid('Paths must not be empty.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, flags.config as string | undefined),
    flags.profile as string | undefined,
  );
  const client = platformClient(credential, Math.ceil(seconds * 1000), signal);
  const result =
    command.kind === 'get'
      ? await client.preferences.get()
      : await client.preferences.update({
          agentMessageMode: command.agentMessageMode,
          defaultModel: command.defaultModel,
          clearDefaultModel: command.clearDefaultModel,
        });
  process.stdout.write(
    `${JSON.stringify(result, null, flags.json ? undefined : 2)}\n`,
  );
}
