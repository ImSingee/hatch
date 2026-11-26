/** Instance theme commands. */
import type { JsonObject } from '@bufbuild/protobuf';
import {
  THEME_APPEARANCES,
  THEME_MODES,
  THEME_PRESET_NAMES,
  isThemePresetName,
  type ThemeAppearance,
  type ThemeMode,
} from '../../hatch-design-tokens/src';
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
import { CliError } from './error';
import { readInput } from './input';

/** Theme documents are small; a larger file is not a theme. */
const MAX_THEME_BYTES = 16_384;

export type ThemeCommand =
  | { kind: 'get'; resolve: ThemeAppearance[] | 'mode' }
  | {
      kind: 'set';
      accent?: AccentName;
      clearAccent?: true;
      dockLabels?: boolean;
      mode?: ThemeMode;
      appearance?: ThemeAppearance;
      preset?: string;
      /** `--file`: a path, or `-` for stdin. */
      file?: string;
    }
  | { kind: 'check'; file: string }
  | { kind: 'presets' }
  | { kind: 'reset' };

const OPERATIONS = ['get', 'set', 'check', 'presets', 'reset'] as const;
type Operation = (typeof OPERATIONS)[number];

const OPTIONS: Record<Operation, Parameters<typeof parseCommandArgs>[3]> = {
  get: { resolved: { type: 'boolean' }, appearance: { type: 'string' } },
  set: {
    accent: { type: 'string' },
    'clear-accent': { type: 'boolean' },
    'dock-labels': { type: 'boolean' },
    'no-dock-labels': { type: 'boolean' },
    mode: { type: 'string' },
    appearance: { type: 'string' },
    preset: { type: 'string' },
    file: { type: 'string' },
  },
  check: { file: { type: 'string' } },
  presets: {},
  reset: {},
};

function appearanceFlag(flags: Flags): ThemeAppearance | undefined {
  const appearance = textFlag(flags, 'appearance');
  if (
    appearance !== undefined &&
    !(THEME_APPEARANCES as readonly string[]).includes(appearance)
  )
    throw invalid('--appearance must be light or dark.');
  return appearance as ThemeAppearance | undefined;
}

/** `--file` keeps `-` (stdin); any other value is a path. */
function fileFlag(flags: Flags): string | undefined {
  return textFlag(flags, 'file');
}

function parseSet(flags: Flags): ThemeCommand {
  const accent = textFlag(flags, 'accent');
  if (accent !== undefined && !isAccentName(accent))
    throw invalid(`--accent must be one of: ${ACCENT_NAMES.join(', ')}.`);
  const clearAccent = flags['clear-accent'] === true;
  if (accent !== undefined && clearAccent)
    throw invalid('Supply at most one of --accent and --clear-accent.');
  const show = flags['dock-labels'] === true;
  const hide = flags['no-dock-labels'] === true;
  if (show && hide)
    throw invalid('Supply at most one of --dock-labels and --no-dock-labels.');
  const mode = textFlag(flags, 'mode');
  if (mode !== undefined && !(THEME_MODES as readonly string[]).includes(mode))
    throw invalid('--mode must be light, dark or system.');
  const appearance = appearanceFlag(flags);
  const preset = textFlag(flags, 'preset');
  const file = fileFlag(flags);
  if (preset !== undefined && file !== undefined)
    throw invalid('Supply at most one of --preset and --file.');
  if ((preset !== undefined || file !== undefined) && !appearance)
    throw invalid(
      `--${preset !== undefined ? 'preset' : 'file'} needs --appearance light|dark: the theme it replaces.`,
    );
  if (appearance && preset === undefined && file === undefined)
    throw invalid('--appearance needs --preset <name> or --file <path|->.');
  if (preset !== undefined && !isThemePresetName(preset))
    throw invalid(`--preset must be one of: ${THEME_PRESET_NAMES.join(', ')}.`);
  if (
    accent === undefined &&
    !clearAccent &&
    !show &&
    !hide &&
    mode === undefined &&
    !appearance
  )
    throw invalid(
      'Supply --accent, --clear-accent, --dock-labels, --no-dock-labels, --mode, or --appearance with --preset or --file.',
    );
  return {
    kind: 'set',
    ...(accent === undefined ? {} : { accent }),
    ...(clearAccent ? { clearAccent: true as const } : {}),
    ...(show || hide ? { dockLabels: show } : {}),
    ...(mode === undefined ? {} : { mode: mode as ThemeMode }),
    ...(appearance ? { appearance } : {}),
    ...(preset === undefined ? {} : { preset }),
    ...(file === undefined ? {} : { file }),
  };
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseThemeCommand(
  args: readonly string[],
  offset: number,
): { command: ThemeCommand; flags: Flags } {
  const operation = args[offset + 1];
  if (!(OPERATIONS as readonly (string | undefined)[]).includes(operation))
    throw invalid(
      'Use hatch theme get, set, check, presets or reset. See hatch help theme.',
    );
  const op = operation as Operation;
  const { flags, positionals } = parseCommandArgs(args, offset, 2, OPTIONS[op]);
  if (positionals.length)
    throw invalid('This command takes no positional arguments.');
  switch (op) {
    case 'get': {
      const appearance = appearanceFlag(flags);
      const resolved = flags.resolved === true;
      if (appearance && !resolved)
        throw invalid('--appearance needs --resolved.');
      return {
        command: {
          kind: 'get',
          resolve: !resolved ? [] : appearance ? [appearance] : 'mode',
        },
        flags,
      };
    }
    case 'set':
      return { command: parseSet(flags), flags };
    case 'check': {
      const file = fileFlag(flags);
      if (file === undefined) throw invalid('Supply --file <path|->.');
      return { command: { kind: 'check', file }, flags };
    }
    case 'presets':
      return { command: { kind: 'presets' }, flags };
    case 'reset':
      return { command: { kind: 'reset' }, flags };
  }
}

function readTheme(file: string, signal: AbortSignal): Promise<JsonObject> {
  return readInput(file, signal, MAX_THEME_BYTES) as Promise<JsonObject>;
}

export async function runTheme(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseThemeCommand(args, offset);
  // Read the file before connecting, so an unreadable one sends nothing.
  const document =
    command.kind === 'check' || (command.kind === 'set' && command.file)
      ? await readTheme(command.file!, signal)
      : undefined;
  const client = await openClient(flags, signal);
  switch (command.kind) {
    case 'get': {
      if (command.resolve !== 'mode') {
        printResult(await client.theme.get(command.resolve), flags);
        return;
      }
      // The appearance the mode draws; both while it follows the device.
      const { mode } = await client.theme.get();
      printResult(
        await client.theme.get(
          mode === 'system' ? ['light', 'dark'] : [mode as ThemeAppearance],
        ),
        flags,
      );
      return;
    }
    case 'set':
      printResult(
        await client.theme.set({
          accent: command.accent,
          clearAccent: command.clearAccent,
          dockLabels: command.dockLabels,
          mode: command.mode,
          appearance: command.appearance,
          preset: command.preset,
          custom: document,
        }),
        flags,
      );
      return;
    case 'check': {
      const result = await client.theme.validate(document!);
      if (!result.ok)
        // The code `set` gets from the platform for the same document.
        throw new CliError(
          'THEME_INVALID',
          [
            'The theme was rejected:',
            ...result.problems.map((problem) => `- ${problem.message}`),
          ].join('\n'),
          2,
          undefined,
          { problems: result.problems },
        );
      printResult(result, flags);
      return;
    }
    case 'presets':
      printResult(await client.theme.presets(), flags);
      return;
    case 'reset':
      printResult(await client.theme.reset(), flags);
  }
}
