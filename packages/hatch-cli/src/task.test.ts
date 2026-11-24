import { describe, expect, it } from 'vitest';
import { parseTaskCommand } from './task';

const parse = (...args: string[]) =>
  parseTaskCommand(['app', 'task', ...args], 0);

describe('hatch app task arguments', () => {
  it('maps run input, waiting and its longer default timeout', () => {
    expect(parse('run', 'digest-app', 'digest')).toMatchObject({
      action: 'run',
      id: 'digest-app',
      target: 'digest',
      input: undefined,
      wait: false,
      timeoutMs: 60_000,
    });
    expect(
      parse(
        'run',
        'digest-app',
        'digest',
        '--input',
        '{"repo":"a/b"}',
        '--wait',
      ),
    ).toMatchObject({
      input: { inline: { repo: 'a/b' } },
      wait: true,
      timeoutMs: 600_000,
    });
    expect(
      parse('run', 'digest-app', 'digest', '--file', '-', '--timeout', '30'),
    ).toMatchObject({ input: { file: '-' }, timeoutMs: 30_000 });
  });

  it('maps run listing filters and paging', () => {
    expect(
      parse(
        'runs',
        'digest-app',
        '--task',
        'digest',
        '--status',
        'failed',
        '--limit',
        '200',
        '--cursor',
        '01abc',
        '--json',
      ),
    ).toMatchObject({
      action: 'runs',
      task: 'digest',
      status: 'failed',
      limit: 200,
      cursor: '01abc',
      json: true,
    });
    expect(parse('get-run', 'digest-app', '01abc')).toMatchObject({
      action: 'get-run',
      target: '01abc',
    });
    expect(parse('cancel', 'digest-app', '01abc')).toMatchObject({
      action: 'cancel',
      target: '01abc',
    });
  });

  it.each([
    [['launch', 'a'], /list, run, runs, get-run or cancel/],
    [['run', 'a'], /task name/],
    [['list', 'a', 'extra'], /exactly one App/],
    [
      ['run', 'a', 'b', '--input', '{}', '--file', 'x'],
      /at most one of --input and --file/,
    ],
    [['run', 'a', 'b', '--input', '[1]'], /JSON object/],
    [['run', 'a', 'b', '--input', 'nope'], /JSON object/],
    [['runs', 'a', '--status', 'done'], /--status must be one of/],
    [['runs', 'a', '--limit', '201'], /between 1 and 200/],
    [['runs', 'a', '--cursor', ''], /--cursor/],
    [['list', 'a', '--wait'], /--wait applies only to task run/],
    [['run', 'a', 'b', '--task', 'x'], /--task applies only to task runs/],
    [['get-run', 'a', 'r', '--timeout', '0'], /--timeout/],
    [['run', 'a', 'b', '--bogus'], /--bogus is not a flag/],
  ])('rejects %j', (args, message) => {
    expect(() => parse(...args)).toThrow(message);
  });
});
