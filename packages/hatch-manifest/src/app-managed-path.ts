/** Canonical name of the platform-owned App SDK/config directory. */
export const APP_MANAGED_DIR = '.hatch';
export const APP_REGISTRY_CONFIG = '.npmrc';
export const APP_UNSUPPORTED_ROOT_CONFIGS = [
  'deno.jsonc',
  'tsconfig.json',
  'jsconfig.json',
] as const;

/**
 * Root files a Node-toolchain source may not contain. pnpm would read each one
 * as an alternate manifest, a registry or auth source, an install hook, or a
 * workspace definition, and the type checker uses only the platform-generated
 * `.hatch/tsconfig.json`.
 */
export const NODE_TOOLCHAIN_REJECTED_ROOT_FILES = [
  APP_REGISTRY_CONFIG,
  'package.json5',
  'package.yaml',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'pnpm-workspace.yml',
  'pnpm-workspaces.yaml',
  'pnpm-workspaces.yml',
  '.pnpm-workspace.yaml',
  '.pnpm-workspace.yml',
  '.pnpm-workspaces.yaml',
  '.pnpm-workspaces.yml',
  ...APP_UNSUPPORTED_ROOT_CONFIGS,
] as const;

/**
 * pnpm writes this file itself (for example when a dependency asks to run a
 * build script). Install ignores it, deploy never copies it, and worktrees
 * exclude it from Git.
 */
export const NODE_TOOLCHAIN_IGNORED_ROOT_FILE = 'pnpm-workspace.yaml';

/**
 * App source can move between case-sensitive and case-insensitive filesystems.
 * Treat every ASCII case variant as the same reserved path segment so a source
 * accepted on Linux cannot alias the platform-owned directory on macOS.
 */
export function isAppManagedPathSegment(segment: string): boolean {
  return segment.toLowerCase() === APP_MANAGED_DIR;
}

/** The App root registry configuration is injected and owned by the platform. */
export function isAppRegistryConfigName(name: string): boolean {
  return name.toLowerCase() === APP_REGISTRY_CONFIG;
}

/** Match a root entry against the Node-toolchain rejected names. */
export function isNodeToolchainRejectedRootFile(name: string): boolean {
  const normalized = name.toLowerCase();
  return NODE_TOOLCHAIN_REJECTED_ROOT_FILES.some(
    (candidate) => candidate === normalized,
  );
}

/** App builds use one canonical root deno.json and no alternate TS config. */
export function isUnsupportedAppRootConfigName(name: string): boolean {
  const normalized = name.toLowerCase();
  return APP_UNSUPPORTED_ROOT_CONFIGS.some(
    (candidate) => candidate === normalized,
  );
}
