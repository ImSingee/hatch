/** Theme commands: the caller's own accent and dock labels. */
import {
  ACCENT_NAMES,
  isAccentName,
  type AccentName,
} from '../../../src/ui/theme/accents';
import {
  invalid,
  openClient,
  parseCommandArgs,
  printResult,
  textFlag,
  type Flags,
} from './command-session';

export type ThemeCommand =
  | { kind: 'get' }
  | { kind: 'set'; accent?: AccentName; dockLabels?: boolean };

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseThemeCommand(
  args: readonly string[],
  offset: number,
): { command: ThemeCommand; flags: Flags } {
  const operation = args[offset + 1];
  if (operation !== 'get' && operation !== 'set')
    throw invalid('Use hatch theme get or hatch theme set.');
  const { flags, positionals } = parseCommandArgs(
    args,
    offset,
    2,
    operation === 'set'
      ? {
          accent: { type: 'string' },
          'dock-labels': { type: 'boolean' },
          'no-dock-labels': { type: 'boolean' },
        }
      : {},
  );
  if (positionals.length)
    throw invalid('This command takes no positional arguments.');
  if (operation === 'get') return { command: { kind: 'get' }, flags };
  const accent = textFlag(flags, 'accent');
  if (accent !== undefined && !isAccentName(accent))
    throw invalid(`--accent must be one of: ${ACCENT_NAMES.join(', ')}.`);
  const show = flags['dock-labels'] === true;
  const hide = flags['no-dock-labels'] === true;
  if (show && hide)
    throw invalid('Supply at most one of --dock-labels and --no-dock-labels.');
  if (accent === undefined && !show && !hide)
    throw invalid('Supply --accent, --dock-labels or --no-dock-labels.');
  return {
    command: {
      kind: 'set',
      ...(accent === undefined ? {} : { accent }),
      ...(show || hide ? { dockLabels: show } : {}),
    },
    flags,
  };
}

export async function runTheme(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseThemeCommand(args, offset);
  const client = await openClient(flags, signal);
  printResult(
    command.kind === 'get'
      ? await client.theme.get()
      : await client.theme.set({
          accent: command.accent,
          dockLabels: command.dockLabels,
        }),
    flags,
  );
}
