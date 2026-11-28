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

  it('starts over when the sign-in changes during the account lookup', async () => {
    const tokens = ['token-a', 'token-b'];
    await expect(
      readRuntimeSession({
        readToken: async () => tokens.shift() ?? null,
        accountId: async () => 'user-b',
        signal: signal(),
      }),
    ).rejects.toThrow('The sign-in changed.');
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
