import { describe, expect, it } from 'vitest';
import { readRuntimeSession } from './runtime-session';

describe('readRuntimeSession', () => {
  const signal = () => new AbortController().signal;

  it('pairs the credential with the account it belongs to', async () => {
    await expect(
      readRuntimeSession({
        readToken: async () => 'token-a',
        accountId: async () => 'user-a',
        signal: signal(),
      }),
    ).resolves.toEqual({ token: 'token-a', account: 'user-a' });
  });

  it('looks up the account of the very credential it read', async () => {
    // The vault changes during the lookup (another sign-in, then back):
    // the account still belongs to the credential that is configured.
    const vault = ['token-a', 'token-b', 'token-a'];
    const accounts: Record<string, string> = {
      'token-a': 'user-a',
      'token-b': 'user-b',
    };
    const session = await readRuntimeSession({
      readToken: async () => vault.shift() ?? null,
      accountId: async (credential) => {
        vault.shift();
        return accounts[credential] ?? null;
      },
      signal: signal(),
    });
    expect(session).toEqual({ token: 'token-a', account: 'user-a' });
  });

  it('refuses a session without a credential before asking for the account', async () => {
    let asked = false;
    await expect(
      readRuntimeSession({
        readToken: async () => null,
        accountId: async () => {
          asked = true;
          return 'user-a';
        },
        signal: signal(),
      }),
    ).rejects.toThrow('no sign-in');
    expect(asked).toBe(false);
  });

  it('configures nothing once the session ended', async () => {
    const ended = new AbortController();
    await expect(
      readRuntimeSession({
        readToken: async () => 'token-a',
        accountId: async () => {
          ended.abort();
          return 'user-a';
        },
        signal: ended.signal,
      }),
    ).rejects.toThrow('The session changed.');
  });
});
