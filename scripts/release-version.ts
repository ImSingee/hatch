/**
 * Rewrites every product version in the repository to one release version.
 * The release workflow runs it before committing and tagging a release.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Strict semver 2.0.0, without a leading `v`.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type ReleaseVersion = {
  /** Full semver, such as `1.2.0-rc.1`. */
  version: string;
  /** `major.minor.patch` only, for stores that reject prerelease suffixes. */
  core: string;
};

export function parseReleaseVersion(input: string): ReleaseVersion {
  const version = input.trim().replace(/^v/, '');
  const match = SEMVER.exec(version);
  if (!match)
    throw new Error(
      `"${input}" is not a semantic version such as 1.2.0 or v1.2.0-rc.1.`,
    );
  return { version, core: `${match[1]}.${match[2]}.${match[3]}` };
}

type VersionFile = {
  path: string;
  rewrite: (source: string, release: ReleaseVersion) => string;
};

function jsonVersion(path: string): VersionFile {
  return {
    path,
    // Edit the top-level line in place so the file keeps its formatting,
    // then confirm that the line really was the document's version.
    rewrite: (source, { version }) => {
      const next = replaceOnce(
        path,
        source,
        /(\n {2}"version": ")[^"]*(",?\n)/,
        version,
      );
      if ((JSON.parse(next) as { version?: unknown }).version !== version)
        throw new Error(`${path}: the replaced line is not its "version".`);
      return next;
    },
  };
}

/** Replaces the single match of `pattern`, keeping its first and last group. */
function replaceOnce(
  path: string,
  source: string,
  pattern: RegExp,
  value: string,
): string {
  const matches = source.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (matches?.length !== 1)
    throw new Error(
      `${path}: expected exactly one version match, found ${matches?.length ?? 0}.`,
    );
  return source.replace(pattern, (_, before: string, after: string) => {
    return `${before}${value}${after}`;
  });
}

/** Every product version the release must keep in step. */
export const VERSION_FILES: VersionFile[] = [
  jsonVersion('packages/hatch-cli/package.json'),
  jsonVersion('packages/hatch-platform-api/package.json'),
  jsonVersion('desktop/package.json'),
  jsonVersion('desktop/src-tauri/tauri.conf.json'),
  {
    path: 'desktop/src-tauri/Cargo.toml',
    rewrite: (source, { version }) =>
      replaceOnce(
        'desktop/src-tauri/Cargo.toml',
        source,
        /(\[package\]\nname = "hatch-desktop"\nversion = ")[^"]*(")/,
        version,
      ),
  },
  {
    path: 'desktop/src-tauri/Cargo.lock',
    rewrite: (source, { version }) =>
      replaceOnce(
        'desktop/src-tauri/Cargo.lock',
        source,
        /(\[\[package\]\]\nname = "hatch-desktop"\nversion = ")[^"]*(")/,
        version,
      ),
  },
  jsonVersion('mobile/package.json'),
  {
    // iOS CFBundleShortVersionString only accepts major.minor.patch.
    path: 'mobile/app.config.ts',
    rewrite: (source, { core }) =>
      replaceOnce(
        'mobile/app.config.ts',
        source,
        /(\n {2}version: ')[^']*(',\n)/,
        core,
      ),
  },
  jsonVersion('mobile/modules/hatch-fold/package.json'),
  jsonVersion('mobile/modules/hatch-push-keys/package.json'),
];

/**
 * Rewrites every version file under `root`. It reads and checks all files
 * before writing any, so a mismatch leaves the tree unchanged.
 */
export async function setReleaseVersion(
  root: string,
  input: string,
): Promise<{ version: string; changed: string[] }> {
  const release = parseReleaseVersion(input);
  const updates = await Promise.all(
    VERSION_FILES.map(async ({ path, rewrite }) => {
      const source = await readFile(join(root, path), 'utf8');
      return { path, source, next: rewrite(source, release) };
    }),
  );
  const changed = updates.filter(({ source, next }) => source !== next);
  await Promise.all(
    changed.map(({ path, next }) => writeFile(join(root, path), next)),
  );
  return {
    version: release.version,
    changed: changed.map(({ path }) => path),
  };
}
