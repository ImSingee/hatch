import { apiKeyClient } from '@better-auth/api-key/client';
import { passkeyClient } from '@better-auth/passkey/client';
import { getGlobalBroadcastChannel } from 'better-auth/client';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  // baseURL: "http://localhost:3000", // The base URL of the server (optional if you're using the same domain)
  plugins: [passkeyClient(), apiKeyClient()],
});

export type Session = typeof authClient.$Infer.Session;

/**
 * Tell this browser's other tabs that someone signed in, so their
 * `useSession` re-reads the session and an open tab follows the new account
 * at once. Better Auth announces a sign-out itself, but not a sign-in; tabs
 * that miss this still re-read the session when they become visible.
 */
export function announceSignIn() {
  getGlobalBroadcastChannel().post({
    event: 'session',
    data: { trigger: 'getSession' },
    clientId: crypto.randomUUID(),
  });
}

/**
 * The signed-in user right now, from the session store `useSession` reads;
 * for code that runs outside a render, such as a request's late callback.
 */
export function currentUserId(): string | null {
  const session = authClient.$store.atoms.session?.get() as
    | { data?: { user?: { id?: string } } | null }
    | undefined;
  return session?.data?.user?.id ?? null;
}
