import { spawn } from 'node:child_process';
import { CliError } from './error';
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
  ])
    if (process.env[key]) env[key] = process.env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}
export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  allowFailure = false,
  options: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: options.env ?? childEnvironment(),
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32')
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: 'ignore',
        });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }
    };
    signal.addEventListener('abort', kill, { once: true });
    const timeoutMs = options.timeoutMs ?? 300000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    timer.unref();
    if (signal.aborted) kill();
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
      if (stdout.length > 300 * 1024 * 1024) kill();
    });
    // Kept only so callers can classify a failure; never printed as-is.
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-64 * 1024);
    });
    child.once('error', () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      reject(
        new CliError(
          signal.aborted ? 'cancelled' : 'tool_unavailable',
          signal.aborted
            ? 'Cancelled.'
            : `Could not run ${executable}. Install the required tool and retry.`,
          signal.aborted ? 130 : 7,
        ),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      if (process.platform !== 'win32') kill();
      if (signal.aborted)
        reject(
          new CliError('cancelled', 'Cancelled; workspace retained.', 130),
        );
      // Running out of time is not an exit status: it says nothing about the
      // source, so no caller may read it as the command's own answer.
      else if (timedOut)
        reject(
          new CliError(
            'local_command_timeout',
            `${executable} did not finish within ${Math.ceil(timeoutMs / 1000)} seconds and was stopped. Source was retained; retry.`,
            7,
          ),
        );
      else if ((code ?? 1) !== 0 && !allowFailure)
        reject(
          new CliError(
            'local_command_failed',
            `${executable} failed. Source was retained; inspect the workspace before retrying.`,
            6,
          ),
        );
      else resolveResult({ code: code ?? 1, stdout: stdout.trim(), stderr });
    });
  });
}
export const git = async (
  root: string,
  signal: AbortSignal,
  args: string[],
  allowFailure = false,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
) =>
  command(
    'git',
    [
      '-c',
      'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    root,
    signal,
    allowFailure,
    options,
  );
