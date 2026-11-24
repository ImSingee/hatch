/** Provider model commands: list every kind and move one between kinds. */
import {
  invalid,
  openClient,
  PAGE_OPTIONS,
  pageFlags,
  parseCommandArgs,
  printResult,
  textFlag,
  type Flags,
  type Page,
} from './command-session';

const KINDS = ['chat', 'image'] as const;
type Kind = (typeof KINDS)[number];

export type ModelCommand =
  | { kind: 'list'; modelKind?: Kind; page: Page }
  | { kind: 'set-kind'; id: string; modelKind: Kind };

function kindFlag(flags: Flags): Kind | undefined {
  const value = textFlag(flags, 'kind');
  if (value !== undefined && !KINDS.includes(value as Kind))
    throw invalid('--kind must be chat or image.');
  return value as Kind | undefined;
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseModelCommand(
  args: readonly string[],
  offset: number,
): { command: ModelCommand; flags: Flags } {
  const operation = args[offset + 1];
  if (operation === 'list') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      ...PAGE_OPTIONS,
      kind: { type: 'string' },
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const modelKind = kindFlag(flags);
    return {
      command: {
        kind: 'list',
        ...(modelKind ? { modelKind } : {}),
        page: pageFlags(flags),
      },
      flags,
    };
  }
  if (operation === 'set-kind') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      kind: { type: 'string' },
    });
    if (positionals.length !== 1) throw invalid('Supply exactly one model id.');
    const modelKind = kindFlag(flags);
    if (!modelKind) throw invalid('Supply --kind chat or --kind image.');
    return {
      command: { kind: 'set-kind', id: positionals[0], modelKind },
      flags,
    };
  }
  throw invalid('Use hatch model list or hatch model set-kind.');
}

export async function runModel(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseModelCommand(args, offset);
  const client = await openClient(flags, signal);
  printResult(
    command.kind === 'list'
      ? await client.models.list({ kind: command.modelKind, ...command.page })
      : await client.models.setKind({
          id: command.id,
          kind: command.modelKind,
        }),
    flags,
  );
}
