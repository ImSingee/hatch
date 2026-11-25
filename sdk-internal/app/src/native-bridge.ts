/** Envelope helpers shared by the native bridge entries. */
import { host } from 'nsh';

/** Every `hatch.*` host call answers with one of these. */
export type HostAnswer<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

/** A rejected host call, carrying the Connect code the shell reported. */
export class HostCallError extends Error {
  constructor(
    message: string,
    /** A Connect code name (`invalid_argument`), or an NSH code. */
    readonly code: string,
  ) {
    super(message);
    this.name = 'HostCallError';
  }
}

/**
 * Call a `hatch.*` host function and unwrap its envelope. A host call NSH
 * itself refuses (not granted, timed out) rejects with its own error.
 */
export async function callHost<T extends object>(
  name: string,
  args: unknown,
  timeout?: number,
): Promise<T> {
  const answer = await host.call<HostAnswer<T>>(
    name,
    args,
    timeout === undefined ? undefined : { timeout },
  );
  if (!answer || typeof answer !== 'object') {
    throw new HostCallError(`${name} returned no answer`, 'internal');
  }
  if (!answer.ok) throw new HostCallError(answer.message, answer.code);
  return answer;
}
