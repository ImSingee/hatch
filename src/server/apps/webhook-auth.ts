/**
 * Server-only: platform authentication for public App endpoints (the App
 * webhook in `platform` mode and task webhooks).
 *
 * Accepts, in this order of precedence: explicit native credentials (API key
 * or bearer token), the per-App shared secret (`x-hatch-secret` header or
 * `?secret=`), or a same-origin browser session. Explicit credentials never
 * fall back to a cookie or the shared secret.
 */
import {
  authenticateCredential,
  type CredentialContext,
} from '~server/auth/credentials';
import { secretsMatch } from '~server/secrets';
import {
  isTrustedSessionOrigin,
  sessionOriginError,
} from '~server/session-http-auth';

export type AppWebhookAuth =
  | { ok: false; response: Response }
  | {
      ok: true;
      /** `?secret=` authenticated the call and must not reach the App. */
      stripSecretParam: boolean;
      /** User id, `agent` for an Agent Run, or null for the shared secret. */
      actor: string | null;
    };

/** Who a native credential acts for, as recorded on a run. */
export function credentialActor(context: CredentialContext): string | null {
  if (context.run) return 'agent';
  const status = context.status as { user?: { id?: string } } | undefined;
  return status?.user?.id ?? null;
}

export async function authenticateAppWebhook(
  request: Request,
  webhookSecret: string | null | undefined,
): Promise<AppWebhookAuth> {
  const url = new URL(request.url);
  const headers = request.headers;
  const deny = (status: number, text: string): AppWebhookAuth => ({
    ok: false,
    response: new Response(text, { status }),
  });
  if (headers.has('x-api-key') || headers.has('authorization')) {
    try {
      const context = await authenticateCredential(request);
      return {
        ok: true,
        stripSecretParam: false,
        actor: credentialActor(context),
      };
    } catch {
      return deny(401, 'Unauthorized');
    }
  }
  // Secret header presence wins over the query even when empty.
  if (headers.has('x-hatch-secret') || url.searchParams.has('secret')) {
    const provided =
      headers.get('x-hatch-secret') ?? url.searchParams.get('secret');
    if (!webhookSecret || !secretsMatch(provided, webhookSecret)) {
      return deny(403, 'Forbidden');
    }
    return {
      ok: true,
      stripSecretParam: !headers.has('x-hatch-secret'),
      actor: null,
    };
  }
  // Cookie authentication is ambient authority, including for GET requests
  // that may mutate. Require positive same-origin browser evidence, not just
  // absence of a hostile Origin. Native clients use explicit credentials.
  const originError = sessionOriginError(request);
  if (originError) return { ok: false, response: originError };
  const origin = headers.get('origin');
  if (
    !(origin !== null && isTrustedSessionOrigin(origin)) &&
    !(
      headers.get('sec-fetch-site') === 'same-origin' &&
      isTrustedSessionOrigin(url.origin)
    )
  ) {
    return deny(403, 'Forbidden');
  }
  try {
    const context = await authenticateCredential(request);
    return {
      ok: true,
      stripSecretParam: false,
      actor: credentialActor(context),
    };
  } catch {
    return deny(401, 'Unauthorized');
  }
}
