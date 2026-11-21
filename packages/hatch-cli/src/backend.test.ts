import { describe, expect, it } from 'vitest';
import { parseBackendCommand } from './backend';

const parse = (...args: string[]) =>
  parseBackendCommand(['app', 'backend', ...args], 0);

describe('hatch app backend arguments', () => {
  it('stops gracefully unless --force is given explicitly', () => {
    expect(parse('stop', 'notes')).toMatchObject({
      action: 'stop',
      id: 'notes',
      force: false,
    });
    expect(parse('stop', 'notes', '--force', '--json')).toMatchObject({
      action: 'stop',
      id: 'notes',
      force: true,
      json: true,
    });
    expect(parse('restart', 'notes', '--force')).toMatchObject({
      action: 'restart',
      force: true,
    });
  });

  it('maps the request timeout and target for every action', () => {
    expect(parse('status', 'notes')).toMatchObject({
      action: 'status',
      id: 'notes',
      timeoutMs: 60_000,
    });
    expect(parse('start', 'notes', '--timeout', '5')).toMatchObject({
      action: 'start',
      timeoutMs: 5000,
    });
    expect(parse('list')).toMatchObject({ action: 'list', id: undefined });
  });

  it.each([
    [['status']],
    [['start', 'a', 'b']],
    [['list', 'notes']],
    [['status', 'notes', '--force']],
    [['start', 'notes', '--force']],
    [['list', '--force']],
    [['pause', 'notes']],
    [[]],
    [['stop', 'notes', '--unknown']],
  ])('rejects unusable input before any request: %j', (args) => {
    expect(() => parse(...args)).toThrow(
      expect.objectContaining({ code: 'invalid_arguments' }),
    );
  });

  it('rejects an unusable timeout with its own code', () => {
    expect(() => parse('stop', 'notes', '--timeout', '0')).toThrow(
      expect.objectContaining({ code: 'invalid_timeout' }),
    );
  });
});
