/**
 * Server-only: the signed packages (`.nshpkg`) native shells load.
 *
 * A native deployment's artifact keeps the unsigned package input its build
 * produced (`native-package/`, extracted by finalize). Each time a
 * deployment becomes live, deploy or rollback, `apps.activation_seq` grows in
 * the same transaction, and the live package is that input packed with the
 * new value as its build number and signed with the release key. A rollback
 * therefore ships the older code, byte for byte, under a newer build, which
 * shells accept (they refuse builds older than one they accepted).
 *
 * A signed package is derived data: it is made right after an activation
 * commits and again on request whenever it is missing (a crash, another
 * platform process, a new release key). It is keyed by build, deployment and
 * key, and the first one written for a key wins, so every process serves the
 * same bytes for it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db } from '~/db';
import { WORKSPACE_ROOT, deploymentArtifactDir } from '~agent/paths';
import { AppError } from '~server/errors';
import { NATIVE_PACKAGE_APP_VERSION } from '../../../app-build/format';
import { nshAppId } from './nsh-config';
import { NATIVE_PACKAGE_INPUT_DIR, runNshpkg } from './nshpkg';
import { activeReleaseKeyFiles, ensureSigningKeys } from './signing-keys';

const INPUT_FILE = 'package-input.json';

export function appNativePackagesDir(appId: string): string {
  return path.join(WORKSPACE_ROOT, 'native-packages', appId);
}

export type LiveNativePackage = {
  appId: string;
  deploymentId: string;
  /** The deployment's version (`hatch app rollback --version`). */
  version: number;
  /** The package's build number: the App's activation counter. */
  build: number;
  nshVersion: string | null;
  sha256: string;
  size: number;
  /** Id of the release key that signed it. */
  keyId: string;
  /** Whether it carries bytecode (only a Builder's build does). */
  bytecode: boolean;
  bytes: Buffer;
};

function packageError(code: string, message: string): AppError {
  return new AppError(message, 409, { code });
}

/** What is live for `appId` and the stored input to pack it from. */
async function liveInput(appId: string) {
  const app = await db.query.apps.findFirst({
    where: { id: appId },
    // One read: the build number belongs to this live deployment.
    columns: { id: true, currentDeploymentId: true, activationSeq: true },
  });
  if (!app) throw new AppError(`App "${appId}" not found.`, 404);
  if (!app.currentDeploymentId) {
    throw packageError(
      'nativePackages.appNotDeployed',
      `App "${appId}" has no live deployment.`,
    );
  }
  const deployment = await db.query.deployments.findFirst({
    where: { id: app.currentDeploymentId, appId },
    columns: { id: true, version: true, manifestNormalized: true },
  });
  const manifest = deployment?.manifestNormalized as
    | { app?: { runtime?: string; nshVersion?: string } }
    | null
    | undefined;
  if (!deployment || manifest?.app?.runtime !== 'native') {
    throw packageError(
      'nativePackages.appNotNative',
      `The live deployment of App "${appId}" has no native frontend.`,
    );
  }
  const inputDir = path.join(
    deploymentArtifactDir(appId, deployment.id),
    NATIVE_PACKAGE_INPUT_DIR,
  );
  const input = await fs
    .readFile(path.join(inputDir, INPUT_FILE), 'utf8')
    .then((text) => JSON.parse(text) as { bytecodeVersion?: string | null })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
  // Deployed before packages were signed: its artifact has no input, and
  // the platform does not build App code to make one.
  if (!input || app.activationSeq < 1) {
    throw packageError(
      'nativePackages.unavailable',
      `Version ${deployment.version} of App "${appId}" was deployed before ` +
        'the platform signed native packages. Deploy the App again (or roll ' +
        'back to a version deployed since) to make its package.',
    );
  }
  return {
    deploymentId: deployment.id,
    version: deployment.version,
    build: app.activationSeq,
    nshVersion: manifest.app.nshVersion ?? null,
    bytecode: Boolean(input.bytecodeVersion),
    inputDir,
  };
}

const packing = new Map<string, Promise<void>>();

/** Pack and sign `file` unless it exists; the first one written wins. */
async function ensurePackage(
  appId: string,
  file: string,
  live: Awaited<ReturnType<typeof liveInput>>,
  key: ReturnType<typeof activeReleaseKeyFiles>,
): Promise<void> {
  const exists = await fs
    .access(file)
    .then(() => true)
    .catch(() => false);
  if (exists) return;
  let pending = packing.get(file);
  if (!pending) {
    pending = (async () => {
      const staged = path.join(path.dirname(file), `.pack-${randomUUID()}`);
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await runNshpkg([
          'pack',
          '--input',
          live.inputDir,
          '--id',
          nshAppId(appId),
          '--app-version',
          NATIVE_PACKAGE_APP_VERSION,
          '--build',
          String(live.build),
          '--key',
          key.secret,
          '--cert',
          key.certificate,
          '--root',
          key.root,
          '--out',
          staged,
        ]);
        await fs.link(staged, file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      } finally {
        // A failure is never cached: the next request tries again.
        packing.delete(file);
        await fs.rm(staged, { force: true }).catch(() => {});
      }
    })();
    packing.set(file, pending);
  }
  await pending;
}

/** Remove the packages of builds older than `build` (best effort). */
async function pruneOlder(dir: string, build: number): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => {
        const older = /^(\d+)-/.exec(name);
        return older && Number(older[1]) < build;
      })
      .map((name) => fs.rm(path.join(dir, name), { force: true })),
  );
}

/**
 * The signed package of `appId`'s live deployment, made now if missing.
 * Creates the instance's signing keys the first time.
 */
export async function liveNativePackage(
  appId: string,
): Promise<LiveNativePackage> {
  for (let attempt = 1; ; attempt++) {
    const live = await liveInput(appId);
    const key = activeReleaseKeyFiles(await ensureSigningKeys());
    const dir = appNativePackagesDir(appId);
    const file = path.join(
      dir,
      `${live.build}-${live.deploymentId}-${key.id}.nshpkg`,
    );
    await ensurePackage(appId, file, live, key);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      // A newer activation (here or on another process) pruned this build
      // between packing and reading: serve what is live now.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && attempt < 5)
        continue;
      throw error;
    }
    await pruneOlder(dir, live.build);
    return {
      appId,
      deploymentId: live.deploymentId,
      version: live.version,
      build: live.build,
      nshVersion: live.nshVersion,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      keyId: key.id,
      bytecode: live.bytecode,
      bytes,
    };
  }
}

/**
 * Sign the package of a deployment that just became live. Never fails the
 * activation: a package that could not be made now is made on request.
 */
export async function signActivatedPackage(
  appId: string,
  manifest: { app?: { runtime?: string } } | null | undefined,
): Promise<void> {
  if (manifest?.app?.runtime !== 'native') return;
  try {
    const signed = await liveNativePackage(appId);
    console.log(
      `[apps] signed the native package of ${appId} (build ${signed.build}, ` +
        `version ${signed.version})`,
    );
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === 'nativePackages.unavailable'
    )
      return;
    console.error(
      `[apps] could not sign the native package of ${appId}; it is made on request:`,
      error,
    );
  }
}
