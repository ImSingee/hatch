/** Commands about the platform server itself. */
import {
  invalid,
  openClient,
  parseCommandArgs,
  printResult,
  type Flags,
} from './command-session';

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseServerCommand(
  args: readonly string[],
  offset: number,
): { flags: Flags } {
  if (args[offset + 1] !== 'info') throw invalid('Use hatch server info.');
  const { flags, positionals } = parseCommandArgs(args, offset, 2, {});
  if (positionals.length)
    throw invalid('This command takes no positional arguments.');
  return { flags };
}

export async function runServer(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { flags } = parseServerCommand(args, offset);
  const client = await openClient(flags, signal);
  printResult(await client.server.info(), flags);
}
