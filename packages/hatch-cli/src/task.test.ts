import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from './error';

type RunView = { id: string; status: string; error: string | null };
const client = vi.hoisted(() => ({
  signal: null as AbortSignal | null,
  run: vi.fn<() => Promise<{ runId: string; status: string }>>(),
  get: vi.fn<() => Promise<RunView>>(),
}));
vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return {
    ...actual,
    platformClient: (
      _credential: unknown,
      _timeout: number,
      signal: AbortSignal,
    ) => {
      client.signal = signal;
      return { apps: { task: { run: client.run, get: client.get } } };
    },
  };
});
import { parseTaskCommand, runTask } from './task';

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
    expect(parse('rotate-webhook-secret', 'digest-app')).toMatchObject({
      action: 'rotate-webhook-secret',
      id: 'digest-app',
    });
  });

  it.each([
    [['launch', 'a'], /get-run, cancel or rotate-webhook-secret/],
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
    [['rotate-webhook-secret'], /exactly one App/],
    [['rotate-webhook-secret', 'a', 'b'], /exactly one App/],
    [['rotate-webhook-secret', 'a', '--input', '{}'], /--input applies only/],
    [['run', 'a', 'b', '--task', 'x'], /--task applies only to task runs/],
    [['get-run', 'a', 'r', '--timeout', '0'], /--timeout/],
    [['run', 'a', 'b', '--bogus'], /--bogus is not a flag/],
  ])('rejects %j', (args, message) => {
    expect(() => parse(...args)).toThrow(message);
  });
});

describe('hatch app task run --wait', () => {
  const view = (status: string): RunView => ({
    id: 'run-1',
    status,
    error: status === 'failed' ? 'boom' : null,
  });
  let stdout: string[];
  beforeEach(() => {
    vi.stubEnv('HATCH_CLI_URL', 'http://127.0.0.1:9');
    vi.stubEnv('HATCH_CLI_TOKEN', 'fixture-session');
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    client.run.mockResolvedValue({ runId: 'run-1', status: 'queued' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('leaves stdout to the error envelope when a run fails under --json', async () => {
    client.get.mockResolvedValue({
      ...view('failed'),
      steps: [],
      output: null,
      log: '',
      queuePosition: null,
    } as never);
    const error = await runTask(
      ['app', 'task', 'run', 'a', 'digest', '--wait', '--json'],
      0,
      new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: 'task_run_failed',
      exitCode: 6,
      details: { runId: 'run-1', status: 'failed', run: { error: 'boom' } },
    });
    expect(stdout).toEqual([]);
  });

  it('bounds the whole wait, requests included, by --timeout', async () => {
    client.get.mockResolvedValue(view('queued') as never);
    const error = await runTask(
      ['app', 'task', 'run', 'a', 'digest', '--wait', '--timeout', '0.3'],
      0,
      new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'timeout', exitCode: 7 });
    // Requests carry the deadline, not only the caller's cancel signal.
    expect(client.signal?.aborted).toBe(true);
  });
});
