/** Personal preference commands (`hatch preferences get|set`). */
import { parseArgs } from 'node:util';
import { platformClient } from './client';
import { configPath, resolveCredential } from './config';
import { CliError } from './error';

export const AGENT_MESSAGE_MODES = ['queue', 'steer'] as const;
export type AgentMessageMode = (typeof AGENT_MESSAGE_MODES)[number];

type Flags = Record<string, string | boolean | undefined>;
const invalid = (message: string) => new CliError('invalid_arguments', message);

export type PreferencesCommand =
  | { kind: 'get' }
  | { kind: 'set'; agentMessageMode: AgentMessageMode };

const GLOBALS = {
  json: { type: 'boolean' },
  config: { type: 'string' },
  profile: { type: 'string' },
  workdir: { type: 'string' },
  timeout: { type: 'string' },
} as const;

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
      options: {
        ...GLOBALS,
        ...(operation === 'set'
          ? { 'agent-message-mode': { type: 'string' } }
          : {}),
      },
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
  const modes = new Set(
    (parsed.tokens ?? []).flatMap((token) =>
      token.kind === 'option' && token.name === 'agent-message-mode'
        ? [token.value]
        : [],
    ),
  );
  if (modes.size > 1) throw invalid('Supply --agent-message-mode only once.');
  const mode = flags['agent-message-mode'];
  if (mode === undefined)
    throw invalid('Supply --agent-message-mode queue|steer.');
  if (!(AGENT_MESSAGE_MODES as readonly unknown[]).includes(mode))
    throw invalid('--agent-message-mode must be queue or steer.');
  return {
    command: { kind: 'set', agentMessageMode: mode as AgentMessageMode },
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
        });
  process.stdout.write(
    `${JSON.stringify(result, null, flags.json ? undefined : 2)}\n`,
  );
}
