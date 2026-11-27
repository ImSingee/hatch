/**
 * Theme commands: the caller's own active theme, accent and dock labels, and
 * the shared theme library.
 */
import type { JsonObject } from '@bufbuild/protobuf';
import {
  ACCENT_NAMES,
  isAccentName,
  type AccentName,
} from '../../../src/ui/theme/accents';
import {
  PAGE_OPTIONS,
  invalid,
  onePositional,
  openClient,
  pageFlags,
  parseCommandArgs,
  printResult,
  textFlag,
  type Flags,
  type Page,
} from './command-session';
import { CliError } from './error';
import { readInput } from './input';

/** Theme documents are small; a larger file is not a theme. */
const MAX_THEME_BYTES = 16_384;
/** Preset names and custom theme ids (lowercase ULIDs). */
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ThemeCommand =
  | { kind: 'get'; resolve: boolean }
  | {
      kind: 'set';
      accent?: AccentName;
      clearAccent?: true;
      dockLabels?: boolean;
      /** The theme to activate: a preset name or a custom theme id. */
      theme?: string;
    }
  | { kind: 'list'; page: Page }
  /** `file`: a path, or `-` for stdin. */
  | { kind: 'create'; file: string }
  | { kind: 'update'; id: string; file: string }
  | { kind: 'delete'; id: string }
  | { kind: 'check'; file: string }
  | { kind: 'reset' };

const OPERATIONS = [
  'get',
  'set',
  'list',
  'create',
  'update',
  'delete',
  'check',
  'reset',
] as const;
type Operation = (typeof OPERATIONS)[number];

const FILE = { file: { type: 'string' } } as const;
const OPTIONS: Record<Operation, Parameters<typeof parseCommandArgs>[3]> = {
  get: { resolved: { type: 'boolean' } },
  set: {
    accent: { type: 'string' },
    'clear-accent': { type: 'boolean' },
    'dock-labels': { type: 'boolean' },
    'no-dock-labels': { type: 'boolean' },
    theme: { type: 'string' },
  },
  list: PAGE_OPTIONS,
  create: FILE,
  update: FILE,
  delete: { yes: { type: 'boolean' } },
  check: FILE,
  reset: {},
};

/** Operations that take one theme id as their positional argument. */
const WITH_ID: readonly Operation[] = ['update', 'delete'];

function themeId(value: string, label: string): string {
  if (!THEME_ID.test(value))
    throw invalid(
      `${label} must be a theme id from hatch theme list (lowercase letters, digits and hyphens).`,
    );
  return value;
}

function fileFlag(flags: Flags): string {
  const file = textFlag(flags, 'file');
  if (file === undefined) throw invalid('Supply --file <path|->.');
  return file;
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
  const themeFlag = textFlag(flags, 'theme');
  const theme =
    themeFlag === undefined ? undefined : themeId(themeFlag, '--theme');
  if (
    accent === undefined &&
    !clearAccent &&
    !show &&
    !hide &&
    theme === undefined
  )
    throw invalid(
      'Supply --theme, --accent, --clear-accent, --dock-labels or --no-dock-labels.',
    );
  return {
    kind: 'set',
    ...(accent === undefined ? {} : { accent }),
    ...(clearAccent ? { clearAccent: true as const } : {}),
    ...(show || hide ? { dockLabels: show } : {}),
    ...(theme === undefined ? {} : { theme }),
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
      `Use hatch theme ${OPERATIONS.join(', ')}. See hatch help theme.`,
    );
  const op = operation as Operation;
  const { flags, positionals } = parseCommandArgs(args, offset, 2, OPTIONS[op]);
  if (WITH_ID.includes(op)) {
    const id = themeId(onePositional(positionals, 'theme id'), 'The theme id');
    if (op === 'delete') {
      if (flags.yes !== true)
        throw invalid('Deleting a custom theme cannot be undone; pass --yes.');
      return { command: { kind: 'delete', id }, flags };
    }
    return { command: { kind: 'update', id, file: fileFlag(flags) }, flags };
  }
  if (positionals.length)
    throw invalid('This command takes no positional arguments.');
  switch (op) {
    case 'get':
      return {
        command: { kind: 'get', resolve: flags.resolved === true },
        flags,
      };
    case 'set':
      return { command: parseSet(flags), flags };
    case 'list':
      return { command: { kind: 'list', page: pageFlags(flags) }, flags };
    case 'create':
      return { command: { kind: 'create', file: fileFlag(flags) }, flags };
    case 'check':
      return { command: { kind: 'check', file: fileFlag(flags) }, flags };
    case 'reset':
      return { command: { kind: 'reset' }, flags };
    default:
      throw invalid(`Use hatch theme ${OPERATIONS.join(', ')}.`);
  }
}

/**
 * The note `theme set --theme` prints when the chosen accent hides the
 * theme's own primary; null when it shows as set.
 */
export function accentOverrideNote(state: {
  accent: string | null;
  accentOverridesPrimary: boolean;
  theme: { name: string; primary: string | null };
}): string | null {
  if (!state.accent || !state.accentOverridesPrimary) return null;
  return `Note: the ${state.accent} accent replaces the primary ${state.theme.primary} of the theme "${state.theme.name}". Run hatch theme set --clear-accent to show it.`;
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
    'file' in command ? await readTheme(command.file, signal) : undefined;
  const client = await openClient(flags, signal);
  switch (command.kind) {
    case 'get':
      printResult(await client.theme.get(command.resolve), flags);
      return;
    case 'set': {
      const state = await client.theme.set({
        accent: command.accent,
        clearAccent: command.clearAccent,
        dockLabels: command.dockLabels,
        theme: command.theme,
      });
      const note = command.theme ? accentOverrideNote(state) : null;
      if (note && !flags.json) process.stderr.write(`${note}\n`);
      printResult(state, flags);
      return;
    }
    case 'list':
      printResult(await client.theme.list(command.page), flags);
      return;
    case 'create':
      printResult(await client.theme.create(document!), flags);
      return;
    case 'update':
      printResult(await client.theme.update(command.id, document!), flags);
      return;
    case 'delete':
      printResult(await client.theme.delete(command.id), flags);
      return;
    case 'check': {
      const result = await client.theme.validate(document!);
      if (!result.ok)
        // The code `create` and `update` get from the platform.
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
    case 'reset':
      printResult(await client.theme.reset(), flags);
  }
}
