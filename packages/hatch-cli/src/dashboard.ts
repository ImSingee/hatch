/** Dashboard and dashboard widget commands. */
import {
  invalid,
  openClient,
  PAGE_OPTIONS,
  pageFlags,
  parseCommandArgs,
  printResult,
  textFlag,
  type Flags,
  type OptionSpec,
  type Page,
} from './command-session';

export const MAX_DASHBOARD_NAME_LENGTH = 500;
export const MAX_DASHBOARD_DESCRIPTION_LENGTH = 4000;
export const MAX_AUTO_REFRESH_SECONDS = 3600;

const BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];
const COLUMNS: Record<Breakpoint, number> = {
  desktop: 12,
  tablet: 8,
  mobile: 4,
};
const MAX_Y = 10_000;
const MAX_HEIGHT = 100;

export type WidgetPosition = {
  breakpoint: Breakpoint;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
};

export type DashboardCommand =
  | { kind: 'list'; page: Page }
  | { kind: 'get'; id: string }
  | { kind: 'create'; name: string; description?: string }
  | {
      kind: 'update';
      id: string;
      name?: string;
      /** Empty clears the description. */
      description?: string;
      /** 0 turns automatic refresh off. */
      autoRefreshSeconds?: number;
    }
  | { kind: 'delete'; id: string }
  | { kind: 'widget-available' }
  | {
      kind: 'widget-add';
      dashboardId: string;
      app: string;
      widgetId: string;
      position?: WidgetPosition;
    }
  | {
      kind: 'widget-layout';
      dashboardId: string;
      placementId: string;
      position: WidgetPosition;
    }
  | { kind: 'widget-remove'; dashboardId: string; placementId: string };

function name(flags: Flags): string | undefined {
  const value = textFlag(flags, 'name');
  if (value === undefined) return undefined;
  if (!value.trim()) throw invalid('--name must not be blank.');
  if (Array.from(value.trim()).length > MAX_DASHBOARD_NAME_LENGTH)
    throw invalid(`--name exceeds ${MAX_DASHBOARD_NAME_LENGTH} characters.`);
  return value.trim();
}

function description(flags: Flags): string | undefined {
  const value = textFlag(flags, 'description');
  if (value === undefined) return undefined;
  // Blank text would silently clear the description.
  if (!value.trim())
    throw invalid(
      '--description must not be blank; use --clear-description instead.',
    );
  if (Array.from(value.trim()).length > MAX_DASHBOARD_DESCRIPTION_LENGTH)
    throw invalid(
      `--description exceeds ${MAX_DASHBOARD_DESCRIPTION_LENGTH} characters.`,
    );
  return value.trim();
}

/** A flag holding a whole number in [min, max]. */
function integer(
  flags: Flags,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  const value = textFlag(flags, flag);
  if (value === undefined) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw invalid(`--${flag} must be a whole number from ${min} to ${max}.`);
  return parsed;
}

const POSITION_OPTIONS: OptionSpec = {
  breakpoint: { type: 'string' },
  x: { type: 'string' },
  y: { type: 'string' },
  w: { type: 'string' },
  h: { type: 'string' },
};

/** The position flags; `undefined` when none of them was given. */
function position(flags: Flags): WidgetPosition | undefined {
  const given = textFlag(flags, 'breakpoint');
  if (given !== undefined && !BREAKPOINTS.includes(given as Breakpoint))
    throw invalid(`--breakpoint must be one of: ${BREAKPOINTS.join(', ')}.`);
  const breakpoint = (given ?? 'desktop') as Breakpoint;
  const columns = COLUMNS[breakpoint];
  const x = integer(flags, 'x', 0, columns - 1);
  const y = integer(flags, 'y', 0, MAX_Y);
  const w = integer(flags, 'w', 1, columns);
  const h = integer(flags, 'h', 1, MAX_HEIGHT);
  if (x !== undefined && w !== undefined && x + w > columns)
    throw invalid(
      `--x plus --w must not exceed the ${columns} columns of ${breakpoint}.`,
    );
  if ([x, y, w, h].every((value) => value === undefined)) {
    if (given !== undefined)
      throw invalid('--breakpoint needs at least one of --x, --y, --w, --h.');
    return undefined;
  }
  return { breakpoint, x, y, w, h };
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseDashboardCommand(
  args: readonly string[],
  offset: number,
): { command: DashboardCommand; flags: Flags } {
  const operation = args[offset + 1];
  const parse = (
    depth: number,
    options: OptionSpec,
    positionalNames: readonly string[],
  ) => {
    const parsed = parseCommandArgs(args, offset, depth, options);
    if (
      parsed.positionals.length !== positionalNames.length ||
      parsed.positionals.some((value) => !value)
    )
      throw invalid(
        positionalNames.length
          ? `Supply exactly: ${positionalNames.map((item) => `<${item}>`).join(' ')}.`
          : 'This command takes no positional arguments.',
      );
    return parsed;
  };

  if (operation === 'list') {
    const { flags } = parse(2, PAGE_OPTIONS, []);
    return { command: { kind: 'list', page: pageFlags(flags) }, flags };
  }
  if (operation === 'get') {
    const { flags, positionals } = parse(2, {}, ['dashboard-id']);
    return { command: { kind: 'get', id: positionals[0] }, flags };
  }
  if (operation === 'create') {
    const { flags } = parse(
      2,
      { name: { type: 'string' }, description: { type: 'string' } },
      [],
    );
    const dashboardName = name(flags);
    if (dashboardName === undefined) throw invalid('Supply --name.');
    return {
      command: {
        kind: 'create',
        name: dashboardName,
        description: description(flags),
      },
      flags,
    };
  }
  if (operation === 'update') {
    const { flags, positionals } = parse(
      2,
      {
        name: { type: 'string' },
        description: { type: 'string' },
        'clear-description': { type: 'boolean' },
        'auto-refresh': { type: 'string' },
        'no-auto-refresh': { type: 'boolean' },
      },
      ['dashboard-id'],
    );
    const dashboardName = name(flags);
    const text = description(flags);
    const clear = flags['clear-description'] === true;
    if (text !== undefined && clear)
      throw invalid(
        'Supply at most one of --description and --clear-description.',
      );
    const seconds = integer(flags, 'auto-refresh', 1, MAX_AUTO_REFRESH_SECONDS);
    const off = flags['no-auto-refresh'] === true;
    if (seconds !== undefined && off)
      throw invalid(
        'Supply at most one of --auto-refresh and --no-auto-refresh.',
      );
    const command: DashboardCommand = {
      kind: 'update',
      id: positionals[0],
      name: dashboardName,
      // An empty description is the wire form of "clear".
      description: clear ? '' : text,
      autoRefreshSeconds: off ? 0 : seconds,
    };
    if (
      command.name === undefined &&
      command.description === undefined &&
      command.autoRefreshSeconds === undefined
    )
      throw invalid(
        'Supply --name, --description, --clear-description, --auto-refresh or --no-auto-refresh.',
      );
    return { command, flags };
  }
  if (operation === 'delete') {
    const { flags, positionals } = parse(2, { yes: { type: 'boolean' } }, [
      'dashboard-id',
    ]);
    if (flags.yes !== true)
      throw invalid(
        'Deleting a dashboard removes its widget placements and cannot be undone; pass --yes.',
      );
    return { command: { kind: 'delete', id: positionals[0] }, flags };
  }
  if (operation === 'widget') {
    const action = args[offset + 2];
    if (action === 'available') {
      const { flags } = parse(3, {}, []);
      return { command: { kind: 'widget-available' }, flags };
    }
    if (action === 'add') {
      const { flags, positionals } = parse(
        3,
        {
          app: { type: 'string' },
          widget: { type: 'string' },
          ...POSITION_OPTIONS,
        },
        ['dashboard-id'],
      );
      const app = textFlag(flags, 'app');
      const widgetId = textFlag(flags, 'widget');
      if (app === undefined || widgetId === undefined)
        throw invalid('Supply --app and --widget.');
      return {
        command: {
          kind: 'widget-add',
          dashboardId: positionals[0],
          app,
          widgetId,
          position: position(flags),
        },
        flags,
      };
    }
    if (action === 'layout') {
      const { flags, positionals } = parse(3, POSITION_OPTIONS, [
        'dashboard-id',
        'placement-id',
      ]);
      const next = position(flags);
      if (!next) throw invalid('Supply at least one of --x, --y, --w, --h.');
      return {
        command: {
          kind: 'widget-layout',
          dashboardId: positionals[0],
          placementId: positionals[1],
          position: next,
        },
        flags,
      };
    }
    if (action === 'remove') {
      const { flags, positionals } = parse(3, {}, [
        'dashboard-id',
        'placement-id',
      ]);
      return {
        command: {
          kind: 'widget-remove',
          dashboardId: positionals[0],
          placementId: positionals[1],
        },
        flags,
      };
    }
    throw invalid(
      'Use hatch dashboard widget available, add, layout or remove.',
    );
  }
  throw invalid(
    'Use hatch dashboard list, get, create, update, delete or widget.',
  );
}

export async function runDashboard(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseDashboardCommand(args, offset);
  const { dashboards } = await openClient(flags, signal);
  let result: unknown;
  if (command.kind === 'list') result = await dashboards.list(command.page);
  else if (command.kind === 'get') result = await dashboards.get(command.id);
  else if (command.kind === 'create') result = await dashboards.create(command);
  else if (command.kind === 'update') result = await dashboards.update(command);
  else if (command.kind === 'delete')
    result = await dashboards.delete(command.id);
  else if (command.kind === 'widget-available')
    result = await dashboards.availableWidgets();
  else if (command.kind === 'widget-add')
    result = await dashboards.addWidget(command);
  else if (command.kind === 'widget-layout')
    result = await dashboards.setWidgetLayout(command);
  else result = await dashboards.removeWidget(command);
  printResult(result, flags);
}
