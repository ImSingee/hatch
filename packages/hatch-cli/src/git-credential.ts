/**
 * Git credential helper (gitcredentials(7)) for CLI checkouts. Git runs
 * `hatch git-credential get` and reads the answer from stdout, so plain
 * `git fetch` / `git push` use the same credential as every other command,
 * including a Run token renewed at process start.
 */
import { parseArgs } from 'node:util';
import { configPath, resolveCredential } from './config';
import { CliError } from './error';

async function readRequest(signal: AbortSignal) {
  const fields = new Map<string, string>();
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (signal.aborted) throw new CliError('cancelled', 'Cancelled.', 130);
    text += chunk;
    if (text.length > 64 * 1024) break;
  }
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0)
      fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return fields;
}

export async function runGitCredential(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 1)],
      options: {
        profile: { type: 'string' },
        config: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch {
    throw new CliError(
      'invalid_arguments',
      'Usage: hatch git-credential <get|store|erase>.',
    );
  }
  const action = parsed.positionals[0];
  if (
    parsed.positionals.length !== 1 ||
    !['get', 'store', 'erase'].includes(action)
  )
    throw new CliError(
      'invalid_arguments',
      'Usage: hatch git-credential <get|store|erase>.',
    );
  // Nothing is cached, so there is nothing to store or erase.
  if (action !== 'get') return;
  const request = await readRequest(signal);
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, parsed.values.config),
    parsed.values.profile,
  );
  // Answer only for the instance this credential belongs to.
  if (`${request.get('protocol')}://${request.get('host')}` !== credential.url)
    return;
  process.stdout.write(
    `username=hatch\npassword=${credential.apiKey ?? credential.token}\n`,
  );
}
