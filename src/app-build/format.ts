/**
 * The build package (`hatch-build-v1`): what a build of App source produces
 * and the platform accepts for one deployment. A build runs wherever the
 * source can be executed (the dedicated Builder or the CLI); the platform
 * never executes it, so it re-checks everything here that can be checked
 * without running code and writes the files it serves itself (see
 * src/server/apps/finalize.ts).
 *
 * Layout, relative to the package root:
 *   build.json            BuildPackageManifest
 *   api.binpb             compiled FileDescriptorSet (Apps with `rpc`)
 *   proto/**              the authored proto sources (Apps with `rpc`)
 *   docs/**               the authored doc files the manifest declares
 *   app/**                SPA: index.html (bundle inlined) and app.js;
 *                         native: bundle.js, native/package.nshpkg and
 *                         native/package-root.pub, web/**, nsh-runtime/**
 *   widgets/<id>.js
 *   backend/**            the bundled entry and backend/assets/**
 */
import { z } from 'zod';

export const BUILD_PACKAGE_FORMAT = 'hatch-build-v1';
export const BUILD_PACKAGE_MANIFEST = 'build.json';
export const BUILD_PACKAGE_API_DESCRIPTOR = 'api.binpb';
export const BUILD_PACKAGE_PROTO_DIR = 'proto';
export const BUILD_PACKAGE_DOCS_DIR = 'docs';
/** A native frontend's packaged description (`nsh package` output). */
export const BUILD_PACKAGE_NATIVE_DESCRIPTION = 'app/native-package.json';
/** NSH runtime files the platform publishes once it has checked them. */
export const BUILD_PACKAGE_NSH_RUNTIME_DIR = 'app/nsh-runtime';
/**
 * A native frontend's `nsh publish` package, signed with a key the build
 * made for itself, and that key's root. The platform trusts neither: it
 * takes the package's files as the input of the packages it signs.
 */
export const BUILD_PACKAGE_NATIVE_PACKAGE = 'app/native/package.nshpkg';
export const BUILD_PACKAGE_NATIVE_PACKAGE_ROOT = 'app/native/package-root.pub';
/**
 * The NSH app version every native package carries; the deployment version
 * is the platform's, and the build number is the activation's.
 */
export const NATIVE_PACKAGE_APP_VERSION = '1.0.0';

/** Every top-level entry a package may contain. */
export const BUILD_PACKAGE_ROOT_ENTRIES = [
  BUILD_PACKAGE_MANIFEST,
  BUILD_PACKAGE_API_DESCRIPTOR,
  BUILD_PACKAGE_PROTO_DIR,
  BUILD_PACKAGE_DOCS_DIR,
  'app',
  'widgets',
  'backend',
] as const;

/** Largest package the platform accepts, compressed and expanded. */
export const BUILD_PACKAGE_MAX_COMPRESSED_BYTES = 200 * 1024 * 1024;
export const BUILD_PACKAGE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
export const BUILD_PACKAGE_MAX_FILES = 20_000;
/** Files and directories together, named or implied by a path. */
export const BUILD_PACKAGE_MAX_ENTRIES = 2 * BUILD_PACKAGE_MAX_FILES;

/**
 * Versions of the tools a build ran. The platform accepts a package only
 * from the toolchain it publishes itself (`GetSdk.tooling`): a stale CLI
 * would otherwise deploy output the platform does not support.
 */
export const buildToolingSchema = z.object({
  typescript: z.string().min(1),
  esbuild: z.string().min(1),
  pnpm: z.string().min(1),
  buf: z.string().min(1),
  protocGenEs: z.string().min(1),
  nsh: z.string().min(1).nullable(),
  /** sha256 of the SDK files the source was built against. */
  sdk: z.string().regex(/^[0-9a-f]{64}$/),
});
export type BuildTooling = z.infer<typeof buildToolingSchema>;

export const buildPackageManifestSchema = z.object({
  format: z.literal(BUILD_PACKAGE_FORMAT),
  appId: z.string().min(1),
  /** Empty for a build that is not for a deployment (a local check). */
  deploymentId: z.string(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  toolchain: z.enum(['node', 'deno']),
  /** The manifest file the source declares (`manifest.ts`, `manifest.json`). */
  manifestFile: z.string().min(1),
  /** The evaluated source manifest; the platform validates it again. */
  manifest: z.unknown(),
  /** The evaluated Data Table schema descriptor, when enabled. */
  dataSchema: z.unknown().nullable(),
  tooling: buildToolingSchema,
  /** The build's own log, kept with the deployment. */
  log: z.string().max(1_000_000),
});
export type BuildPackageManifest = z.infer<typeof buildPackageManifestSchema>;

/** The `nsh package` description a native frontend's player is made from. */
export const nativePackageSchema = z.object({
  nshVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  runtime: z.string().min(1),
  wasm: z.string().min(1),
  code: z.string().min(1),
  data: z.record(z.string(), z.string()).optional(),
  sides: z
    .record(z.string(), z.looseObject({ url: z.string().min(1) }))
    .optional(),
  assets: z.record(z.string(), z.string()).optional(),
  fonts: z.array(z.string()).optional(),
  chunks: z.record(z.string(), z.string()).optional(),
  chunkFonts: z.record(z.string(), z.array(z.string())).optional(),
  chunkSides: z.record(z.string(), z.array(z.string())).optional(),
  entryChunks: z.array(z.string()).optional(),
  nativeExports: z.record(z.string(), z.array(z.string())).optional(),
});
export type NativePackage = z.infer<typeof nativePackageSchema>;
