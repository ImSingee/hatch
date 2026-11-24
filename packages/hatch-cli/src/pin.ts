/** Navigation pin commands. */
import {
  invalid,
  listFlag,
  openClient,
  PAGE_OPTIONS,
  pageFlags,
  parseCommandArgs,
  printResult,
  textFlag,
  type Flags,
  type Page,
} from './command-session';

export const MAX_PIN_LABEL_LENGTH = 500;
/** The platform stores at most this many UTF-16 units, without the '#'. */
export const MAX_PIN_ENTRY_LENGTH = 512;
const MAX_REORDER_IDS = 1000;

export type PinCommand =
  | { kind: 'list'; page: Page }
  | {
      kind: 'add-app';
      app: string;
      label?: string;
      entryHash?: string;
      ifAbsent: boolean;
    }
  | { kind: 'update'; id: string; label?: string; entryHash?: string }
  | { kind: 'remove-pin'; pinId: string }
  | { kind: 'remove-app'; app: string }
  | { kind: 'set-dashboard'; dashboardId: string; pinned: boolean }
  | { kind: 'reorder-pins'; pinIds: string[] }
  | { kind: 'reorder-dashboards'; dashboardIds: string[] };

function label(flags: Flags): string | undefined {
  const value = textFlag(flags, 'label');
  if (value === undefined) return undefined;
  if (!value.trim()) throw invalid('--label must not be blank.');
  if (Array.from(value).length > MAX_PIN_LABEL_LENGTH)
    throw invalid(`--label exceeds ${MAX_PIN_LABEL_LENGTH} characters.`);
  return value;
}

function entry(flags: Flags): string | undefined {
  const value = textFlag(flags, 'entry');
  if (value === undefined) return undefined;
  // A bare '#' or blank text would silently mean the App root.
  if (!value.trim().replace(/^#/, '').trim())
    throw invalid('--entry must name a fragment; use --clear-entry instead.');
  if (value.trim().replace(/^#/, '').trim().length > MAX_PIN_ENTRY_LENGTH)
    throw invalid(`--entry exceeds ${MAX_PIN_ENTRY_LENGTH} characters.`);
  return value;
}

/** The one target flag that was supplied, or a rejection naming the choices. */
function oneTarget<T extends string>(
  flags: Flags,
  names: readonly T[],
): { name: T; value: string } {
  const supplied = names.filter((name) => flags[name] !== undefined);
  if (supplied.length !== 1)
    throw invalid(
      `Supply exactly one of ${names.map((name) => `--${name}`).join(', ')}.`,
    );
  return { name: supplied[0], value: textFlag(flags, supplied[0])! };
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parsePinCommand(
  args: readonly string[],
  offset: number,
): { command: PinCommand; flags: Flags } {
  const operation = args[offset + 1];
  const parse = (
    options: Parameters<typeof parseCommandArgs>[3],
    positionalCount = 0,
  ) => {
    const parsed = parseCommandArgs(args, offset, 2, options);
    if (parsed.positionals.length !== positionalCount)
      throw invalid(
        positionalCount
          ? 'Supply exactly one pin id.'
          : 'This command takes no positional arguments.',
      );
    return parsed;
  };
  if (operation === 'list') {
    const { flags } = parse(PAGE_OPTIONS);
    return { command: { kind: 'list', page: pageFlags(flags) }, flags };
  }
  if (operation === 'add') {
    const { flags } = parse({
      app: { type: 'string' },
      dashboard: { type: 'string' },
      label: { type: 'string' },
      entry: { type: 'string' },
      'if-absent': { type: 'boolean' },
    });
    const target = oneTarget(flags, ['app', 'dashboard'] as const);
    const pinLabel = label(flags);
    const entryHash = entry(flags);
    const ifAbsent = flags['if-absent'] === true;
    const appOnly = [
      pinLabel !== undefined && '--label',
      entryHash !== undefined && '--entry',
      ifAbsent && '--if-absent',
    ].filter((name) => name !== false);
    if (target.name !== 'app') {
      if (appOnly.length)
        throw invalid(`${appOnly.join(', ')} can only be used with --app.`);
      return {
        command: {
          kind: 'set-dashboard',
          dashboardId: target.value,
          pinned: true,
        },
        flags,
      };
    }
    if (ifAbsent && appOnly.length > 1)
      throw invalid('--if-absent cannot be combined with --label or --entry.');
    return {
      command: {
        kind: 'add-app',
        app: target.value,
        label: pinLabel,
        entryHash,
        ifAbsent,
      },
      flags,
    };
  }
  if (operation === 'update') {
    const { flags, positionals } = parse(
      {
        label: { type: 'string' },
        entry: { type: 'string' },
        'clear-entry': { type: 'boolean' },
      },
      1,
    );
    const pinLabel = label(flags);
    const entryHash = entry(flags);
    const clear = flags['clear-entry'] === true;
    if (entryHash !== undefined && clear)
      throw invalid('Supply at most one of --entry and --clear-entry.');
    if (pinLabel === undefined && entryHash === undefined && !clear)
      throw invalid('Supply --label, --entry or --clear-entry.');
    return {
      command: {
        kind: 'update',
        id: positionals[0],
        label: pinLabel,
        // An empty entry point clears it.
        entryHash: clear ? '' : entryHash,
      },
      flags,
    };
  }
  if (operation === 'remove') {
    const { flags } = parse({
      pin: { type: 'string' },
      app: { type: 'string' },
      dashboard: { type: 'string' },
    });
    const target = oneTarget(flags, ['pin', 'app', 'dashboard'] as const);
    const commands = {
      pin: { kind: 'remove-pin', pinId: target.value },
      app: { kind: 'remove-app', app: target.value },
      dashboard: {
        kind: 'set-dashboard',
        dashboardId: target.value,
        pinned: false,
      },
    } as const satisfies Record<string, PinCommand>;
    return { command: commands[target.name], flags };
  }
  if (operation === 'reorder') {
    const { flags } = parse({
      pin: { type: 'string', multiple: true },
      dashboard: { type: 'string', multiple: true },
    });
    const pinIds = listFlag(flags, 'pin');
    const dashboardIds = listFlag(flags, 'dashboard');
    if ((pinIds === undefined) === (dashboardIds === undefined))
      throw invalid('Supply --pin <id>... or --dashboard <id>..., not both.');
    const ids = pinIds ?? dashboardIds!;
    if (ids.length > MAX_REORDER_IDS)
      throw invalid(`At most ${MAX_REORDER_IDS} ids can be reordered at once.`);
    return {
      command: pinIds
        ? { kind: 'reorder-pins', pinIds }
        : { kind: 'reorder-dashboards', dashboardIds: dashboardIds! },
      flags,
    };
  }
  throw invalid('Use hatch pin list, add, update, remove or reorder.');
}

export async function runPin(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parsePinCommand(args, offset);
  const { pins } = await openClient(flags, signal);
  let result: unknown;
  if (command.kind === 'list') result = await pins.list(command.page);
  else if (command.kind === 'add-app') result = await pins.pinApp(command);
  else if (command.kind === 'update') result = await pins.updateAppPin(command);
  else if (command.kind === 'remove-pin' || command.kind === 'remove-app')
    result = await pins.unpinApp(command);
  else if (command.kind === 'set-dashboard')
    result = await pins.setDashboardPinned(command);
  else if (command.kind === 'reorder-pins')
    result = await pins.reorderAppPins(command);
  else result = await pins.reorderDashboards(command);
  printResult(result, flags);
}
