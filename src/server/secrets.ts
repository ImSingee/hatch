import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two secrets. Both sides are hashed to a
 * fixed-length digest first so the comparison neither leaks length nor
 * short-circuits on the first differing byte — important for public endpoints
 * (webhooks) where a remote caller can probe timing by repeated guesses.
 */
export function secretsMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Header names for the platform→app HMAC handshake (shared by cron/webhook/KV). */
export const HATCH_TIMESTAMP_HEADER = 'x-hatch-timestamp';
export const HATCH_SIGNATURE_HEADER = 'x-hatch-signature';

/**
 * App-to-App access headers. Requests the platform relays from App A to
 * App B carry A's id and a signature B can verify with its own secret.
 */
export const HATCH_CALLER_APP_HEADER = 'x-hatch-caller-app';
export const HATCH_CALLER_SIGNATURE_HEADER = 'x-hatch-caller-signature';

/**
 * What an App-to-App access signature covers besides the timestamp: the
 * calling App, the HTTP method and the path with its query. The body is not
 * signed so large uploads stream through untouched.
 *
 * The caller signs the path below `/api/app/<caller>/access`; the platform
 * signs the path the target backend receives.
 */
export function appAccessSignaturePayload(
  callerAppId: string,
  method: string,
  pathAndQuery: string,
): string {
  return `${callerAppId}.${method.toUpperCase()} ${pathAndQuery}`;
}

/**
 * Compute the platform's request signature: hex HMAC-SHA256 over
 * `<timestamp>.<payload>` keyed by the per-app signing secret. Binding the
 * timestamp lets the verifier reject replays; `payload` is whatever the caller
 * can reconstruct on both ends (the cron job name for RPC calls, the raw body
 * for webhooks). The result is prefixed `sha256=` so the scheme is greppable and
 * future-proof if the digest ever changes.
 *
 * `payload` may be raw bytes (a Buffer) — used for webhook bodies, which can be
 * binary/non-UTF-8. The digest is taken over the exact bytes, so a string and
 * its UTF-8 encoding produce the same signature (cron job names are unaffected).
 */
export function hatchSignature(
  secret: string,
  timestamp: string,
  payload: string | Buffer,
): string {
  const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const mac = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
    .digest('hex');
  return `sha256=${mac}`;
}

/**
 * Verify a platform signature in constant time, rejecting stale/forged values.
 * `maxSkewMs` bounds how old the timestamp may be (replay protection); default 5
 * minutes. Returns false on any malformed input rather than throwing so callers
 * on hot paths stay branch-simple.
 */
export function verifyHatchSignature(args: {
  secret: string | null | undefined;
  timestamp: string | null | undefined;
  payload: string | Buffer;
  signature: string | null | undefined;
  maxSkewMs?: number;
}): boolean {
  const { secret, timestamp, payload, signature } = args;
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const maxSkewMs = args.maxSkewMs ?? 5 * 60 * 1000;
  if (Math.abs(Date.now() - ts) > maxSkewMs) return false;
  const expected = hatchSignature(secret, timestamp, payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
