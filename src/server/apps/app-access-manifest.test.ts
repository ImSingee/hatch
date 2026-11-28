import { describe, expect, it } from 'vitest';
import {
  appAccessAllows,
  findAppAccessGrant,
} from '../../../packages/hatch-manifest/src/app-access';
import { normalizeManifest, parseSourceManifest } from './manifest';

const backend = {
  capabilities: { backend: true },
  backend: { entry: 'backend/main.ts' },
};

type Case = [label: string, input: unknown, message: RegExp];

function manifest(appAccess: unknown, extra: Record<string, unknown> = {}) {
  return { id: 'caller', name: 'Caller', ...backend, appAccess, ...extra };
}

describe('appAccess manifest', () => {
  it('records each declared grant on the normalized manifest', () => {
    const parsed = parseSourceManifest(
      manifest([
        {
          app: 'todos-id',
          alias: 'todos',
          rpc: ['app.v1.TodoService/ListTodos', 'app.v1.Other/*'],
          dataTables: { read: ['items'], write: ['notes'] },
          tasks: ['digest'],
          webhook: ['/ingest', '/media/*'],
        },
        { app: 'files-id', rpc: ['*'] },
      ]),
    );
    expect(normalizeManifest(parsed).appAccess).toEqual([
      {
        app: 'todos-id',
        alias: 'todos',
        rpc: ['app.v1.TodoService/ListTodos', 'app.v1.Other/*'],
        dataTables: { read: ['items'], write: ['notes'] },
        tasks: ['digest'],
        webhook: ['/ingest', '/media/*'],
      },
      {
        app: 'files-id',
        rpc: ['*'],
        dataTables: { read: [], write: [] },
        tasks: [],
        webhook: [],
      },
    ]);
  });

  it('leaves normalized manifests without appAccess when none is declared', () => {
    const parsed = parseSourceManifest({
      id: 'caller',
      name: 'Caller',
      ...backend,
    });
    expect(normalizeManifest(parsed)).not.toHaveProperty('appAccess');
  });

  it.each<Case>([
    [
      'a backend',
      manifest([{ app: 'b', rpc: ['*'] }], { ...noBackend() }),
      /appAccess: appAccess requires capabilities\.backend/,
    ],
    [
      'a different App',
      manifest([{ app: 'caller', rpc: ['*'] }]),
      /appAccess\[0\]\.app: appAccess must name another App/,
    ],
    [
      'unique targets',
      manifest([
        { app: 'b', rpc: ['*'] },
        { app: 'b', tasks: ['x'] },
      ]),
      /appAccess\[1\]\.app: the same App is listed twice/,
    ],
    [
      'unique aliases',
      manifest([
        { app: 'b', alias: 'x', rpc: ['*'] },
        { app: 'c', alias: 'x', rpc: ['*'] },
      ]),
      /appAccess\[1\]\.alias: duplicate alias/,
    ],
    [
      'at least one grant',
      manifest([{ app: 'b' }]),
      /appAccess\[0\]: grant at least one/,
    ],
    [
      'a Protobuf method',
      manifest([{ app: 'b', rpc: ['/etc/passwd'] }]),
      /appAccess\[0\]\.rpc\[0\]: must be/,
    ],
    [
      'a single method segment',
      manifest([{ app: 'b', rpc: ['a.B/C/D'] }]),
      /appAccess\[0\]\.rpc\[0\]: must be/,
    ],
    [
      'a table name',
      manifest([{ app: 'b', dataTables: { read: ['A-b'] } }]),
      /appAccess\[0\]\.dataTables\.read\[0\]: must be a Data Table name/,
    ],
    [
      'a task name',
      manifest([{ app: 'b', tasks: ['Bad Name'] }]),
      /appAccess\[0\]\.tasks\[0\]: must be a task name/,
    ],
    ...['x', '/a/../b', '/a?b=1', '/a%2fb'].map(
      (path) =>
        [
          `a plain absolute webhook path, not ${path}`,
          manifest([{ app: 'b', webhook: [path] }]),
          /appAccess\[0\]\.webhook\[0\]: must be/,
        ] satisfies Case,
    ),
    [
      'known fields',
      manifest([{ app: 'b', rpc: ['*'], kv: true }]),
      /appAccess\[0\]\.kv: unknown field/,
    ],
  ])('requires %s', (_label, input, message) => {
    expect(() => parseSourceManifest(input)).toThrow(message);
  });
});

function noBackend() {
  return { capabilities: {}, backend: undefined };
}

describe('appAccess grant matching', () => {
  const grants = normalizeManifest(
    parseSourceManifest(
      manifest([
        {
          app: 'todos-id',
          alias: 'todos',
          rpc: ['app.v1.TodoService/ListTodos', 'app.v1.Admin/*'],
          dataTables: { read: ['items'], write: ['notes'] },
          tasks: ['digest'],
          webhook: ['/ingest', '/media/*'],
        },
        { app: 'open-id', rpc: ['*'], webhook: ['*'] },
      ]),
    ),
  ).appAccess;

  it('finds a target by id or alias', () => {
    expect(findAppAccessGrant(grants, 'todos')?.app).toBe('todos-id');
    expect(findAppAccessGrant(grants, 'todos-id')?.app).toBe('todos-id');
    expect(findAppAccessGrant(grants, 'other')).toBeUndefined();
    expect(findAppAccessGrant(undefined, 'todos')).toBeUndefined();
  });

  it('allows only declared RPC methods, services or everything', () => {
    const todos = findAppAccessGrant(grants, 'todos')!;
    const open = findAppAccessGrant(grants, 'open-id')!;
    const rpc = (grant: typeof todos, method: string) =>
      appAccessAllows(grant, { kind: 'rpc', method });
    expect(rpc(todos, 'app.v1.TodoService/ListTodos')).toBe(true);
    expect(rpc(todos, 'app.v1.TodoService/DeleteTodo')).toBe(false);
    expect(rpc(todos, 'app.v1.Admin/Reset')).toBe(true);
    expect(rpc(todos, 'app.v1.AdminX/Reset')).toBe(false);
    expect(rpc(open, 'any.Service/Method')).toBe(true);
  });

  it('lets write imply read but never read imply write', () => {
    const todos = findAppAccessGrant(grants, 'todos')!;
    const data = (table: string, access: 'read' | 'write') =>
      appAccessAllows(todos, { kind: 'data', table, access });
    expect(data('items', 'read')).toBe(true);
    expect(data('items', 'write')).toBe(false);
    expect(data('notes', 'read')).toBe(true);
    expect(data('notes', 'write')).toBe(true);
    expect(data('other', 'read')).toBe(false);
  });

  it('allows only declared tasks', () => {
    const todos = findAppAccessGrant(grants, 'todos')!;
    expect(appAccessAllows(todos, { kind: 'task', task: 'digest' })).toBe(true);
    expect(appAccessAllows(todos, { kind: 'task', task: 'other' })).toBe(false);
  });

  it('matches webhook paths exactly or below a declared prefix', () => {
    const todos = findAppAccessGrant(grants, 'todos')!;
    const open = findAppAccessGrant(grants, 'open-id')!;
    const hook = (grant: typeof todos, path: string) =>
      appAccessAllows(grant, { kind: 'webhook', path });
    expect(hook(todos, '/ingest')).toBe(true);
    expect(hook(todos, '/ingest/more')).toBe(false);
    expect(hook(todos, '/media')).toBe(true);
    expect(hook(todos, '/media/a/b.png')).toBe(true);
    expect(hook(todos, '/mediax')).toBe(false);
    expect(hook(todos, '/')).toBe(false);
    expect(hook(open, '/')).toBe(true);
    expect(hook(open, '/anything/below')).toBe(true);
  });
});
