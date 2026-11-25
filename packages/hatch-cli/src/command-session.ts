/** Argument parsing and client setup shared by the settings commands. */
import { parseArgs } from 'node:util';
import { platformClient, type PlatformClient } from './client';
import { configPath, resolveCredential } from './config';
import { argumentsError, CliError } from './error';

export type Flags = Record<string, string | boolean | string[] | undefined>;
export type OptionSpec = Record<
  string,
  { type: 'string' | 'boolean'; multiple?: boolean }
>;

export const invalid = (message: string) =>
  new CliError('invalid_arguments', message);

const GLOBALS: OptionSpec = {
  json: { type: 'boolean' },
  config: { type: 'string' },
  profile: { type: 'string' },
  workdir: { type: 'string' },
  timeout: { type: 'string' },
};

/** Parse the flags after a command path of `depth` words. */
export function parseCommandArgs(
  args: readonly string[],
  offset: number,
  depth: number,
  options: OptionSpec,
): { flags: Flags; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + depth)],
      options: { ...GLOBALS, ...options },
      allowPositionals: true,
    });
    return { flags: parsed.values as Flags, positionals: parsed.positionals };
  } catch (error) {
    throw argumentsError(error, args[offset] ?? '');
  }
}

/** A string flag's value; rejects an empty one. */
export function textFlag(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw invalid(`--${name} must not be empty.`);
  return value;
}

/** A repeatable string flag's values; rejects empty and repeated ones. */
export function listFlag(flags: Flags, name: string): string[] | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !item))
    throw invalid(`--${name} must not be empty.`);
  if (new Set(value).size !== value.length)
    throw invalid(`--${name} lists the same id more than once.`);
  return value;
}

/**
 * A `--name` / `--no-name` style pair: true, false, or undefined when neither
 * is given. Both together are contradictory.
 */
export function switchFlag(
  flags: Flags,
  on: string,
  off: string,
): boolean | undefined {
  const yes = flags[on] === true;
  const no = flags[off] === true;
  if (yes && no) throw invalid(`Supply at most one of --${on} and --${off}.`);
  return yes ? true : no ? false : undefined;
}

/** A whole-number flag from 1 to `max`. */
export function countFlag(
  flags: Flags,
  name: string,
  max = 4_294_967_295,
): number | undefined {
  const value = textFlag(flags, name);
  if (value === undefined) return undefined;
  const count = Number(value);
  if (!/^\d+$/.test(value) || count < 1 || count > max)
    throw invalid(`--${name} must be a whole number from 1 to ${max}.`);
  return count;
}

/** The single positional id a command takes. */
export function onePositional(positionals: string[], label: string): string {
  if (positionals.length !== 1 || !positionals[0])
    throw invalid(`Supply exactly one ${label}.`);
  return positionals[0];
}

/**
 * One or more ids given as positionals, in order: none empty, longer than
 * 200 characters or repeated, and at most `max` of them.
 */
export function idPositionals(
  positionals: string[],
  label: string,
  max = 1000,
): string[] {
  if (!positionals.length) throw invalid(`Supply at least one ${label}.`);
  if (positionals.some((id) => !id || id.length > 200 || /\s/.test(id)))
    throw invalid(`Each ${label} must be 1-200 characters without spaces.`);
  if (new Set(positionals).size !== positionals.length)
    throw invalid(`The same ${label} is listed more than once.`);
  if (positionals.length > max)
    throw invalid(`At most ${max} ids can be reordered at once.`);
  return positionals;
}

/** The flags of a paged list command. */
export const PAGE_OPTIONS: OptionSpec = {
  limit: { type: 'string' },
  cursor: { type: 'string' },
};

export type Page = { limit: number; cursor?: string };

/** `--limit` (1–100, or 0 for every entry) and `--cursor` of a list. */
export function pageFlags(flags: Flags): Page {
  const limitText = textFlag(flags, 'limit');
  const limit = limitText === undefined ? 0 : Number(limitText);
  if (
    limitText !== undefined &&
    (!/^\d+$/.test(limitText) || limit < 1 || limit > 100)
  )
    throw invalid('--limit must be a whole number from 1 to 100.');
  const cursor = textFlag(flags, 'cursor');
  if (cursor !== undefined && !/^\d{1,9}$/.test(cursor))
    throw invalid(
      '--cursor must be the nextCursor printed by the previous page.',
    );
  return { limit, cursor };
}

/** Resolve the credential and open a client honouring the global flags. */
export async function openClient(
  flags: Flags,
  signal: AbortSignal,
): Promise<PlatformClient> {
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
  return platformClient(credential, Math.ceil(seconds * 1000), signal);
}

/** One complete DTO on stdout: compact with --json, indented otherwise. */
export function printResult(result: unknown, flags: Flags): void {
  process.stdout.write(
    `${JSON.stringify(result, null, flags.json ? undefined : 2)}\n`,
  );
}
