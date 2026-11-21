/**
 * Validation for Node-toolchain dependency files: `package.json` and
 * `pnpm-lock.yaml`.
 *
 * pnpm reads far more than these two files and far more than their dependency
 * fields. Install ignores what it can through fixed arguments, and this module
 * rejects the rest, so the only authored input pnpm acts on is an allow-listed
 * manifest and a lockfile whose every package resolves by registry integrity.
 */
import { promises as fs } from 'node:fs';
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import { isNodeToolchainRejectedRootFile } from './app-managed-path';
import {
  PNPM_LOCKFILE,
  readRootDependencyFile,
  type SourceKind,
} from './source-toolchain';

type JsonObject = Record<string, unknown>;

export type NodeDependencySourceReader = (
  file: string,
) => Promise<string | null>;

const PACKAGE_JSON_KEYS = new Set([
  'name',
  'version',
  'private',
  'description',
  'license',
  'type',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

const PACKAGE_NAME = String.raw`(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*`;
const EXACT_VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
// Peer suffixes nest, e.g. `1.0.0(react@19.0.0(scheduler@0.25.0))`. They name
// registry packages only, so no scheme separator or whitespace can appear.
const PEER_SUFFIX = String.raw`(?:\([A-Za-z0-9@/._~+()-]+\))?`;

const NAME_PATTERN = new RegExp(`^${PACKAGE_NAME}$`);
// A registry range or dist-tag: no scheme, path, or host can be spelled.
const RANGE_PATTERN = /^[0-9A-Za-z.\-+~^<>=|* ]+$/;
const LOCKED_VERSION_PATTERN = new RegExp(`^${EXACT_VERSION}${PEER_SUFFIX}$`);
const PACKAGE_KEY_PATTERN = new RegExp(`^(${PACKAGE_NAME})@${EXACT_VERSION}$`);
const SNAPSHOT_KEY_PATTERN = new RegExp(
  `^(${PACKAGE_NAME})@${EXACT_VERSION}${PEER_SUFFIX}$`,
);
// Transitive npm aliases are recorded as `alias: target@version`.
const SNAPSHOT_DEPENDENCY_PATTERN = new RegExp(
  `^(?:(${PACKAGE_NAME})@)?${EXACT_VERSION}${PEER_SUFFIX}$`,
);
const INTEGRITY_PATTERN = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

const LOCKFILE_KEYS = new Set([
  'lockfileVersion',
  'settings',
  'importers',
  'packages',
  'snapshots',
]);
const LOCKFILE_VERSION = '9.0';
const LOCKFILE_SETTINGS: Record<string, unknown> = {
  autoInstallPeers: true,
  excludeLinksFromLockfile: false,
};
const LOCKED_PACKAGE_KEYS = new Set([
  'resolution',
  'engines',
  'cpu',
  'os',
  'libc',
  'hasBin',
  'peerDependencies',
  'peerDependenciesMeta',
  'deprecated',
  'bundledDependencies',
]);
const SNAPSHOT_KEYS = new Set([
  'dependencies',
  'optionalDependencies',
  'transitivePeerDependencies',
  'optional',
]);

function skillName(kind: SourceKind): string {
  return kind === 'app' ? 'building-apps' : 'building-workflows';
}

function regenerateHelp(kind: SourceKind): string {
  return (
    `Load the "${skillName(kind)}" Skill with read_file, run \`pnpm install ` +
    '--ignore-workspace --ignore-scripts` in the source root, and commit ' +
    `package.json and ${PNPM_LOCKFILE}.`
  );
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isReservedPackage(name: string): 'hatch' | 'jsr' | null {
  if (/^@hatch\//i.test(name)) return 'hatch';
  if (/^@jsr\//i.test(name)) return 'jsr';
  return null;
}

function assertRegistryPackageName(name: string, where: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${where} names an invalid package: "${name}".`);
  }
  const reserved = isReservedPackage(name);
  if (reserved === 'hatch') {
    throw new Error(
      `${name} is provided by Hatch and must not appear in ${where}. Remove ` +
        `it from package.json and regenerate ${PNPM_LOCKFILE}.`,
    );
  }
  if (reserved === 'jsr') {
    throw new Error(
      `${name} in ${where} resolves from the JSR registry. Hatch installs ` +
        'packages from the npm registry only.',
    );
  }
}

function validatePackageJson(raw: string, kind: SourceKind): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `package.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(parsed)) {
    throw new Error('package.json must contain a JSON object.');
  }
  for (const key of Object.keys(parsed)) {
    if (PACKAGE_JSON_KEYS.has(key)) continue;
    if (key === 'packageManager' || key === 'devEngines') {
      throw new Error(
        `package.json must not declare ${key}. It makes pnpm download and ` +
          'run another package manager or runtime. Remove it (`pnpm init` ' +
          'adds packageManager) and regenerate the lockfile; the platform ' +
          'chooses the pnpm version.',
      );
    }
    throw new Error(
      `package.json must not declare ${key}. Hatch ${kind} sources may ` +
        `declare only: ${[...PACKAGE_JSON_KEYS].join(', ')}.`,
    );
  }
  if (parsed.type !== 'module') {
    throw new Error(
      'package.json must declare "type": "module". Hatch sources use ESM.',
    );
  }
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = parsed[section];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) {
      throw new Error(`package.json ${section} must be an object.`);
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      assertRegistryPackageName(name, `package.json ${section}`);
      if (typeof specifier !== 'string' || !RANGE_PATTERN.test(specifier)) {
        throw new Error(
          `Dependency "${name}" in ${section} uses unsupported specifier ` +
            `${JSON.stringify(specifier)}. Use an npm registry version or ` +
            'range; local paths, workspace, git, URL, jsr and alias ' +
            'specifiers are not supported.',
        );
      }
    }
  }
}

function assertKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(
      `${PNPM_LOCKFILE} ${where} has unsupported field "${unexpected}".`,
    );
  }
}

function validateLockfile(raw: string): void {
  const documents = parseAllDocuments(raw, {
    merge: false,
    uniqueKeys: true,
    version: '1.2',
  });
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new Error(`${PNPM_LOCKFILE} is empty.`);
  }
  if (documents.length > 1) {
    throw new Error(
      `${PNPM_LOCKFILE} contains ${documents.length} YAML documents. pnpm ` +
        'writes an extra document for packageManager, devEngines and ' +
        'configDependencies, which Hatch sources must not declare. Remove ' +
        'them and regenerate the lockfile.',
    );
  }
  const [document] = documents;
  const problem = document.errors[0];
  if (problem) {
    throw new Error(`${PNPM_LOCKFILE} is not valid YAML: ${problem.message}`);
  }
  // pnpm and this validator use different YAML parsers. Constructs that let
  // one document mean two things to two parsers are not part of a lockfile.
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      throw new Error(`${PNPM_LOCKFILE} must not use YAML aliases.`);
    }
    if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {
      throw new Error(`${PNPM_LOCKFILE} must not use YAML anchors or tags.`);
    }
  });

  const lock: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isObject(lock)) {
    throw new Error(`${PNPM_LOCKFILE} must contain a YAML mapping.`);
  }
  assertKeys(lock, LOCKFILE_KEYS, 'root');
  if (lock.lockfileVersion !== LOCKFILE_VERSION) {
    throw new Error(
      `${PNPM_LOCKFILE} lockfileVersion must be '${LOCKFILE_VERSION}'; got ` +
        `${JSON.stringify(lock.lockfileVersion)}. Regenerate it with the ` +
        'platform pnpm version.',
    );
  }

  const settings = lock.settings;
  if (!isObject(settings)) {
    throw new Error(`${PNPM_LOCKFILE} settings must be a mapping.`);
  }
  for (const [key, value] of Object.entries(settings)) {
    if (
      !Object.hasOwn(LOCKFILE_SETTINGS, key) ||
      LOCKFILE_SETTINGS[key] !== value
    ) {
      throw new Error(
        `${PNPM_LOCKFILE} records the non-default pnpm setting "${key}". ` +
          'Remove pnpm settings from the source and regenerate the lockfile.',
      );
    }
  }

  const importers = lock.importers;
  if (!isObject(importers) || Object.keys(importers).join() !== '.') {
    throw new Error(
      `${PNPM_LOCKFILE} must describe exactly one project, the source root. ` +
        'Workspaces are not supported.',
    );
  }
  const importer = importers['.'];
  if (!isObject(importer)) {
    throw new Error(`${PNPM_LOCKFILE} importer "." must be a mapping.`);
  }
  assertKeys(importer, new Set(DEPENDENCY_SECTIONS), 'importer "."');
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = importer[section];
    if (dependencies === undefined) continue;
    if (!isObject(dependencies)) {
      throw new Error(`${PNPM_LOCKFILE} ${section} must be a mapping.`);
    }
    for (const [name, entry] of Object.entries(dependencies)) {
      assertRegistryPackageName(name, `${PNPM_LOCKFILE} ${section}`);
      if (
        !isObject(entry) ||
        typeof entry.specifier !== 'string' ||
        typeof entry.version !== 'string' ||
        !RANGE_PATTERN.test(entry.specifier) ||
        !LOCKED_VERSION_PATTERN.test(entry.version)
      ) {
        throw new Error(
          `${PNPM_LOCKFILE} locks "${name}" to something other than an npm ` +
            'registry version. Local, workspace, git and URL dependencies ' +
            'are not supported.',
        );
      }
    }
  }

  const packages = lock.packages ?? {};
  if (!isObject(packages)) {
    throw new Error(`${PNPM_LOCKFILE} packages must be a mapping.`);
  }
  for (const [key, entry] of Object.entries(packages)) {
    const name = PACKAGE_KEY_PATTERN.exec(key)?.[1];
    if (!name) {
      throw new Error(
        `${PNPM_LOCKFILE} package "${key}" is not an npm registry package ` +
          'at an exact version.',
      );
    }
    assertRegistryPackageName(name, `${PNPM_LOCKFILE} packages`);
    if (!isObject(entry)) {
      throw new Error(`${PNPM_LOCKFILE} package "${key}" must be a mapping.`);
    }
    assertKeys(entry, LOCKED_PACKAGE_KEYS, `package "${key}"`);
    const resolution = entry.resolution;
    if (
      !isObject(resolution) ||
      Object.keys(resolution).join() !== 'integrity' ||
      typeof resolution.integrity !== 'string' ||
      !INTEGRITY_PATTERN.test(resolution.integrity)
    ) {
      throw new Error(
        `${PNPM_LOCKFILE} package "${key}" must resolve by registry ` +
          'integrity only. Tarball URLs, git sources, directories and ' +
          'runtime downloads are not supported.',
      );
    }
  }

  const snapshots = lock.snapshots ?? {};
  if (!isObject(snapshots)) {
    throw new Error(`${PNPM_LOCKFILE} snapshots must be a mapping.`);
  }
  for (const [key, entry] of Object.entries(snapshots)) {
    const name = SNAPSHOT_KEY_PATTERN.exec(key)?.[1];
    if (!name) {
      throw new Error(
        `${PNPM_LOCKFILE} snapshot "${key}" is not an npm registry package ` +
          'at an exact version.',
      );
    }
    assertRegistryPackageName(name, `${PNPM_LOCKFILE} snapshots`);
    if (!isObject(entry)) {
      throw new Error(`${PNPM_LOCKFILE} snapshot "${key}" must be a mapping.`);
    }
    assertKeys(entry, SNAPSHOT_KEYS, `snapshot "${key}"`);
    for (const section of ['dependencies', 'optionalDependencies'] as const) {
      const dependencies = entry[section];
      if (dependencies === undefined) continue;
      if (!isObject(dependencies)) {
        throw new Error(
          `${PNPM_LOCKFILE} snapshot "${key}" ${section} must be a mapping.`,
        );
      }
      for (const [dependency, version] of Object.entries(dependencies)) {
        const match =
          typeof version === 'string'
            ? SNAPSHOT_DEPENDENCY_PATTERN.exec(version)
            : null;
        if (!NAME_PATTERN.test(dependency) || !match) {
          throw new Error(
            `${PNPM_LOCKFILE} snapshot "${key}" links "${dependency}" to ` +
              'something other than an npm registry version.',
          );
        }
        assertRegistryPackageName(
          match[1] ?? dependency,
          `${PNPM_LOCKFILE} snapshots`,
        );
      }
    }
  }
}

/**
 * Require the Node-toolchain dependency contract before pnpm sees the source.
 * Shared by deploy validation, Runner worktree preparation and the CLI.
 */
export async function validateNodeDependencySource(
  sourceDir: string,
  kind: SourceKind,
  sourceReader?: NodeDependencySourceReader,
): Promise<void> {
  // Names are listed, never probed, so every site rejects the same case
  // variants; `sourceReader` only changes how file contents are read.
  const rejected = (await fs.readdir(sourceDir)).find(
    isNodeToolchainRejectedRootFile,
  );
  if (rejected) {
    throw new Error(
      `${kind} sources cannot include ${rejected}. Package manager, ` +
        'registry and TypeScript configuration is managed by the platform: ' +
        `declare dependencies in package.json and commit ${PNPM_LOCKFILE}.`,
    );
  }

  const readSource =
    sourceReader ?? ((file: string) => readRootDependencyFile(sourceDir, file));
  const [packageSource, lockSource] = await Promise.all([
    readSource('package.json'),
    readSource(PNPM_LOCKFILE),
  ]);
  if (packageSource === null) {
    throw new Error(
      `Missing package.json for ${kind} dependencies. ${regenerateHelp(kind)}`,
    );
  }
  if (lockSource === null) {
    throw new Error(
      `Missing source-controlled ${PNPM_LOCKFILE} for ${kind}. ` +
        regenerateHelp(kind),
    );
  }
  validatePackageJson(packageSource, kind);
  validateLockfile(lockSource);
}
