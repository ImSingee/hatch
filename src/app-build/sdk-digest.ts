/**
 * The digest of an SDK delivery (`GetSdk` files): a build package records the
 * SDK it was built against, and the platform accepts only its own.
 */
import { createHash } from 'node:crypto';

export function sdkFilesDigest(
  files: readonly { path: string; contentBase64: string }[],
): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(`${file.path}\0${file.contentBase64}\n`);
  }
  return hash.digest('hex');
}
