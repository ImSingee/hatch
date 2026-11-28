/** What the native App runtime is configured with for one signed-in session. */
export type RuntimeSession = { token: string; account: string };

/**
 * Reads the session's credential and the account it belongs to. Apps keep
 * their storage per account, so the account is looked up with that very
 * credential, never another read of the vault: the pair always matches.
 */
export async function readRuntimeSession({
  readToken,
  accountId,
  signal,
}: {
  readToken: () => Promise<string | null>;
  /** The account `credential` belongs to. */
  accountId: (
    credential: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
  signal: AbortSignal;
}): Promise<RuntimeSession> {
  const token = await readToken();
  if (!token) throw new Error('This instance has no sign-in on this phone.');
  const account = await accountId(token, signal);
  // Signing out or switching instances cancels the caller: a credential read
  // for the session that ended configures nothing.
  if (signal.aborted) throw new Error('The session changed.');
  if (!account) throw new Error('This sign-in has no account.');
  return { token, account };
}
