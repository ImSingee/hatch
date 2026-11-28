/**
 * Identifier grammars shared by the manifest, the platform and the CLI.
 * Dependency-free so every consumer can import it.
 */
import { APP_SLUG_MAX_LENGTH } from './app-identity.js';

/** Task names appear in URLs and CLI arguments. */
export const APP_TASK_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
export const APP_TASK_NAME_MAX_LENGTH = 64;

/**
 * Canonical app-id shape: lowercase alphanumerics and hyphens, safe as a path
 * segment. A leading digit is allowed so generated ULID ids (e.g.
 * `01jabc...`) pass alongside legacy kebab-case ids (`habit-tracker`). This is
 * an internal, immutable identifier — see `APP_SLUG_RE` for the human URL slug.
 */
export const APP_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Canonical app-slug shape: lowercase letters, digits, and hyphens, starting
 * with a letter or digit. Used in the mutable, human-facing `/app/<slug>` URL.
 * Slugs and immutable ids occupy independent namespaces.
 */
export const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** True when `id` is a safe app-id path segment (ULID or legacy kebab). */
export function isValidAppId(id: string): boolean {
  return APP_ID_RE.test(id);
}

/** True when `slug` is a valid, human-facing app URL slug. */
export function isValidAppSlug(slug: string): boolean {
  return slug.length <= APP_SLUG_MAX_LENGTH && APP_SLUG_RE.test(slug);
}

/** Data Table and field names. */
export const DATA_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;

/**
 * A fully qualified Connect method path, `package.Service/Method` (an
 * unpackaged `Service/Method` is also valid). Protobuf identifiers only: no
 * URLs, encoded separators or dot segments.
 */
export const RPC_METHOD_PATH_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*\/[A-Za-z_][A-Za-z0-9_]*$/;

/** A fully qualified Protobuf service name, `package.Service`. */
export const RPC_SERVICE_NAME_RE =
  /^(?:[A-Za-z_][A-Za-z0-9_]*\.)*[A-Za-z_][A-Za-z0-9_]*$/;

export function isRpcMethodPath(value: string): boolean {
  return RPC_METHOD_PATH_RE.test(value);
}
