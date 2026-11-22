import { describe, expect, it } from 'vitest';
import { parseDashboardCommand } from './dashboard';

const command = (...args: string[]) => parseDashboardCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parseDashboardCommand(args, 0);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};

describe('dashboard command arguments', () => {
  it('maps each command to one explicit operation', () => {
    expect(command('dashboard', 'list')).toEqual({
      kind: 'list',
      page: { limit: 0, cursor: undefined },
    });
    expect(
      command('dashboard', 'list', '--limit', '1', '--cursor', '1'),
    ).toEqual({ kind: 'list', page: { limit: 1, cursor: '1' } });
    expect(command('dashboard', 'get', 'd1')).toEqual({
      kind: 'get',
      id: 'd1',
    });
    expect(command('dashboard', 'create', '--name', ' Ops ')).toEqual({
      kind: 'create',
      name: 'Ops',
      description: undefined,
    });
    expect(command('dashboard', 'delete', 'd1', '--yes')).toEqual({
      kind: 'delete',
      id: 'd1',
    });
    expect(command('dashboard', 'widget', 'available')).toEqual({
      kind: 'widget-available',
    });
    expect(
      command(
        'dashboard',
        'widget',
        'add',
        'd1',
        '--app',
        'notes',
        '--widget',
        'w',
      ),
    ).toEqual({
      kind: 'widget-add',
      dashboardId: 'd1',
      app: 'notes',
      widgetId: 'w',
      position: undefined,
    });
    expect(
      command(
        'dashboard',
        'widget',
        'add',
        'd1',
        '--app',
        'notes',
        '--widget',
        'w',
        '--breakpoint',
        'tablet',
        '--w',
        '4',
        '--h',
        '3',
      ),
    ).toMatchObject({
      position: {
        breakpoint: 'tablet',
        w: 4,
        h: 3,
        x: undefined,
        y: undefined,
      },
    });
    // Position flags default to the desktop breakpoint.
    expect(
      command('dashboard', 'widget', 'layout', 'd1', 'p1', '--x', '6'),
    ).toEqual({
      kind: 'widget-layout',
      dashboardId: 'd1',
      placementId: 'p1',
      position: {
        breakpoint: 'desktop',
        x: 6,
        y: undefined,
        w: undefined,
        h: undefined,
      },
    });
    expect(command('dashboard', 'widget', 'remove', 'd1', 'p1')).toEqual({
      kind: 'widget-remove',
      dashboardId: 'd1',
      placementId: 'p1',
    });
  });

  it('distinguishes unchanged, replaced and cleared fields', () => {
    expect(command('dashboard', 'update', 'd1', '--name', 'Ops')).toEqual({
      kind: 'update',
      id: 'd1',
      name: 'Ops',
      description: undefined,
      autoRefreshSeconds: undefined,
    });
    expect(
      command('dashboard', 'update', 'd1', '--clear-description'),
    ).toMatchObject({ description: '' });
    expect(
      command('dashboard', 'update', 'd1', '--auto-refresh', '60'),
    ).toMatchObject({ autoRefreshSeconds: 60 });
    expect(
      command('dashboard', 'update', 'd1', '--no-auto-refresh'),
    ).toMatchObject({ autoRefreshSeconds: 0 });
  });

  it('rejects contradictory, ambiguous or unusable input', () => {
    for (const args of [
      ['dashboard'],
      ['dashboard', 'show'],
      ['dashboard', 'list', 'extra'],
      ['dashboard', 'list', '--limit', '0'],
      ['dashboard', 'list', '--limit', '101'],
      ['dashboard', 'list', '--limit', '2.5'],
      ['dashboard', 'list', '--limit'],
      ['dashboard', 'list', '--cursor', 'abc'],
      ['dashboard', 'list', '--cursor', ''],
      ['dashboard', 'get'],
      ['dashboard', 'create'],
      ['dashboard', 'create', '--name', '  '],
      ['dashboard', 'create', '--name', 'x'.repeat(501)],
      ['dashboard', 'create', '--name', 'Ops', '--description', ' '],
      ['dashboard', 'update', 'd1'],
      ['dashboard', 'update', '--name', 'Ops'],
      [
        'dashboard',
        'update',
        'd1',
        '--description',
        'a',
        '--clear-description',
      ],
      ['dashboard', 'update', 'd1', '--auto-refresh', '0'],
      ['dashboard', 'update', 'd1', '--auto-refresh', '3601'],
      ['dashboard', 'update', 'd1', '--auto-refresh', '1.5'],
      ['dashboard', 'update', 'd1', '--auto-refresh', '5', '--no-auto-refresh'],
      // Deleting is irreversible and needs an explicit flag.
      ['dashboard', 'delete', 'd1'],
      ['dashboard', 'widget'],
      ['dashboard', 'widget', 'add', 'd1', '--app', 'notes'],
      ['dashboard', 'widget', 'add', '--app', 'notes', '--widget', 'w'],
      [
        'dashboard',
        'widget',
        'add',
        'd1',
        '--app',
        'notes',
        '--widget',
        'w',
        '--breakpoint',
        'tablet',
      ],
      ['dashboard', 'widget', 'layout', 'd1', 'p1'],
      ['dashboard', 'widget', 'layout', 'd1', '--x', '1'],
      [
        'dashboard',
        'widget',
        'layout',
        'd1',
        'p1',
        '--breakpoint',
        'watch',
        '--x',
        '1',
      ],
      ['dashboard', 'widget', 'layout', 'd1', 'p1', '--x', '-1'],
      // Mobile has four columns.
      [
        'dashboard',
        'widget',
        'layout',
        'd1',
        'p1',
        '--breakpoint',
        'mobile',
        '--w',
        '5',
      ],
      ['dashboard', 'widget', 'layout', 'd1', 'p1', '--x', '8', '--w', '6'],
      ['dashboard', 'widget', 'layout', 'd1', 'p1', '--h', '0'],
      ['dashboard', 'widget', 'remove', 'd1'],
    ])
      expect({ args, code: rejected(...args) }).toEqual({
        args,
        code: 'invalid_arguments',
      });
  });
});
