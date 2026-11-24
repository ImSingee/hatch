import { describe, expect, it } from 'vitest';
import { parsePinCommand } from './pin';

const command = (...args: string[]) => parsePinCommand(args, 0).command;
const rejected = (...args: string[]) => {
  try {
    parsePinCommand(args, 0);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};

describe('pin command arguments', () => {
  it('maps each command to one explicit operation', () => {
    expect(command('pin', 'list')).toEqual({
      kind: 'list',
      page: { limit: 0, cursor: undefined },
    });
    expect(command('pin', 'list', '--limit', '20', '--cursor', '40')).toEqual({
      kind: 'list',
      page: { limit: 20, cursor: '40' },
    });
    expect(command('pin', 'add', '--app', 'notes')).toEqual({
      kind: 'add-app',
      app: 'notes',
      label: undefined,
      entryHash: undefined,
      ifAbsent: false,
    });
    expect(
      command(
        'pin',
        'add',
        '--app',
        'notes',
        '--label',
        'Inbox',
        '--entry',
        '#/inbox',
      ),
    ).toMatchObject({ label: 'Inbox', entryHash: '#/inbox', ifAbsent: false });
    expect(
      command('pin', 'add', '--app', 'notes', '--if-absent'),
    ).toMatchObject({ kind: 'add-app', ifAbsent: true });
    expect(command('pin', 'add', '--dashboard', 'default')).toEqual({
      kind: 'set-dashboard',
      dashboardId: 'default',
      pinned: true,
    });
    expect(command('pin', 'remove', '--dashboard', 'default')).toEqual({
      kind: 'set-dashboard',
      dashboardId: 'default',
      pinned: false,
    });
    expect(command('pin', 'remove', '--pin', 'p1')).toEqual({
      kind: 'remove-pin',
      pinId: 'p1',
    });
    expect(command('pin', 'remove', '--app', 'notes')).toEqual({
      kind: 'remove-app',
      app: 'notes',
    });
    expect(
      command('pin', 'reorder', '--pin', 'b', '--pin', 'a', '--pin', 'c'),
    ).toEqual({ kind: 'reorder-pins', pinIds: ['b', 'a', 'c'] });
    expect(command('pin', 'reorder', '--dashboard', 'd2')).toEqual({
      kind: 'reorder-dashboards',
      dashboardIds: ['d2'],
    });
  });

  it('distinguishes unchanged, replaced and cleared pin fields', () => {
    expect(command('pin', 'update', 'p1', '--label', 'Inbox')).toEqual({
      kind: 'update',
      id: 'p1',
      label: 'Inbox',
      entryHash: undefined,
    });
    expect(command('pin', 'update', 'p1', '--entry', '/inbox')).toEqual({
      kind: 'update',
      id: 'p1',
      label: undefined,
      entryHash: '/inbox',
    });
    // An empty entry point is the wire form of "clear".
    expect(command('pin', 'update', 'p1', '--clear-entry')).toEqual({
      kind: 'update',
      id: 'p1',
      label: undefined,
      entryHash: '',
    });
  });

  it('rejects contradictory, ambiguous or unusable input', () => {
    for (const args of [
      ['pin'],
      ['pin', 'show'],
      ['pin', 'list', 'extra'],
      ['pin', 'list', '--limit', '0'],
      ['pin', 'list', '--limit', '101'],
      ['pin', 'list', '--cursor', '-1'],
      // Exactly one target.
      ['pin', 'add'],
      ['pin', 'add', 'notes'],
      ['pin', 'add', '--app', 'notes', '--dashboard', 'default'],
      ['pin', 'add', '--app', ''],
      // App-only options on other targets, and --if-absent with fields that
      // an existing pin would silently not receive.
      ['pin', 'add', '--dashboard', 'default', '--label', 'Default'],
      ['pin', 'add', '--dashboard', 'default', '--if-absent'],
      ['pin', 'add', '--app', 'notes', '--if-absent', '--label', 'Inbox'],
      ['pin', 'add', '--app', 'notes', '--label', '  '],
      ['pin', 'add', '--app', 'notes', '--label', 'x'.repeat(501)],
      // A blank fragment would mean the App root without saying so.
      ['pin', 'add', '--app', 'notes', '--entry', '#'],
      // The platform keeps 512 characters; longer would be cut silently.
      ['pin', 'add', '--app', 'notes', '--entry', `#/${'x'.repeat(512)}`],
      ['pin', 'update', 'p1'],
      ['pin', 'update', '--label', 'Inbox'],
      ['pin', 'update', 'p1', 'p2', '--label', 'Inbox'],
      ['pin', 'update', 'p1', '--entry', '/a', '--clear-entry'],
      ['pin', 'update', 'p1', '--entry', ' '],
      ['pin', 'remove'],
      ['pin', 'remove', 'p1'],
      ['pin', 'remove', '--pin', 'p1', '--app', 'notes'],
      ['pin', 'reorder'],
      ['pin', 'reorder', 'a', 'b'],
      ['pin', 'reorder', '--pin', 'a', '--dashboard', 'd'],
      ['pin', 'reorder', '--pin', 'a', '--pin', 'a'],
      ['pin', 'reorder', '--pin', ''],
    ])
      expect({ args, code: rejected(...args) }).toEqual({
        args,
        code: 'invalid_arguments',
      });
  });
});
