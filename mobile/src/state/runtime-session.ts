/** What the native App runtime is configured with for one signed-in session. */
export type RuntimeSession = { token: string; account: string };

/**
 * Reads the session's credential and the account it belongs to, as one
 * snapshot: Apps keep their storage per account, so a credential must never
 * be paired with another account's id. A sign-in that replaces the
 * credential while the account is looked up starts over.
 */
export async function readRuntimeSession({
  readToken,
  accountId,
  signal,
}: {
  readToken: () => Promise<string | null>;
  /** The account of the credential the client sends now. */
  accountId: (signal: AbortSignal) => Promise<string | null>;
  signal: AbortSignal;
}): Promise<RuntimeSession> {
  const token = await readToken();
  if (!token) throw new Error('This instance has no sign-in on this phone.');
  const account = await accountId(signal);
  if ((await readToken()) !== token) throw new Error('The sign-in changed.');
  // Signing out or switching instances cancels the caller: a credential read
  // for the session that ended configures nothing.
  if (signal.aborted) throw new Error('The session changed.');
  if (!account) throw new Error('This sign-in has no account.');
  return { token, account };
}
