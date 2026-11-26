/**
 * The local build: produce a build package from a source export on this
 * machine, with the platform's pinned toolchain.
 *
 * `hatch app deploy --build local` installs the toolchain into a cache
 * directory and runs this file from there (`node build-driver.mjs <request>`),
 * so esbuild and TypeScript resolve from the cache's node_modules; the
 * request names that directory for the tools it runs as commands. It writes
 * build output to stderr as it runs and one JSON result line to stdout.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { BuildHost } from '../../../src/app-build/host';
import { buildAppSource } from '../../../src/app-build/produce';
import { AppManifestValidationError } from '../../../src/server/apps/manifest-validation';
import { sdkFilesDigest } from '../../../src/app-build/sdk-digest';
import { run } from '../../../src/server/subprocess';
import { pnpmInvocation } from './pnpm';
import { childEnvironment } from './process';

const requestSchema = z.object({
  appId: z.string().min(1),
  deploymentId: z.string(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  sourceDir: z.string().min(1),
  outDir: z.string().min(1),
  workDir: z.string().min(1),
  /** Holds node_modules with the pinned tsc, buf and protoc-gen-es. */
  toolchainDir: z.string().min(1),
  /** JSON file with the `GetSdk` files ({path, contentBase64}[]). */
  sdkFiles: z.string().min(1),
  tooling: z.object({
    typescript: z.string().min(1),
    esbuild: z.string().min(1),
    pnpm: z.string().min(1),
    buf: z.string().min(1),
    protocGenEs: z.string().min(1),
    nsh: z.string().nullable(),
  }),
});

function executable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `nsh` of the platform's version: HATCH_NSH_BIN, PATH or ~/.nsh. */
function nshBinary(version: string): string {
  const configured = process.env.HATCH_NSH_BIN?.trim();
  const candidates = configured
    ? [path.resolve(configured)]
    : [
        ...(process.env.PATH ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.resolve(dir, 'nsh')),
        path.join(os.homedir(), '.local', 'bin', 'nsh'),
        path.join(os.homedir(), '.nsh', 'bin', 'nsh'),
      ];
  const seen: string[] = [];
  for (const file of candidates) {
    if (!executable(file)) continue;
    const probe = spawnSync(file, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const found = /^nsh (\S+)/.exec(probe.stdout ?? '')?.[1];
    if (probe.status === 0 && found === version) return file;
    seen.push(`${file} (${found ?? 'not usable'})`);
  }
  throw Object.assign(
    new Error(
      `Native Apps need nsh ${version}, ` +
        (seen.length
          ? `but found only ${seen.join(', ')}. `
          : 'but none was found. ') +
        `Install it with \`curl -fsSL https://nsh.dev/install.sh | NSH_VERSION=v${version} sh\`, ` +
        'or set HATCH_NSH_BIN to an nsh binary of that version.',
    ),
    { code: 'nsh_unavailable' },
  );
}

async function main(): Promise<void> {
  const request = requestSchema.parse(
    JSON.parse(await readFile(process.argv[2]!, 'utf8')),
  );
  const sdkFiles = z
    .array(z.object({ path: z.string(), contentBase64: z.string() }))
    .parse(JSON.parse(await readFile(request.sdkFiles, 'utf8')));
  const env = childEnvironment();
  const pnpm = await pnpmInvocation(process.platform, env);
  const print = (text: string) => process.stderr.write(`${text}\n`);
  const modules = path.join(request.toolchainDir, 'node_modules');
  const TSC = path.join(modules, 'typescript', 'bin', 'tsc');
  const bin = path.join(modules, '.bin');

  const host: BuildHost = {
    workDir: request.workDir,
    toolchainContext(root, logs) {
      // Show the build as it runs; the log stays complete in the package.
      const push = logs.push.bind(logs);
      logs.push = (...items: string[]) => {
        for (const item of items) print(item);
        return push(...items);
      };
      return {
        root,
        logs,
        async run({ tool, args, cwd, input, timeoutMs, env: extra }) {
          const [command, commandArgs] =
            tool === 'tsc'
              ? [process.execPath, [TSC, ...args]]
              : tool === 'node'
                ? [process.execPath, args]
                : tool === 'pnpm'
                  ? [pnpm.executable, [...pnpm.prefix, ...args]]
                  : ['deno', args];
          return run(command, commandArgs, {
            cwd: cwd ?? root,
            env: { ...env, ...extra },
            input,
            timeoutMs,
          });
        },
      };
    },
    async runBuf(args, cwd) {
      return run(path.join(bin, 'buf'), args, {
        cwd,
        env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ''}` },
      });
    },
    async materializeSdk(root) {
      for (const file of sdkFiles) {
        const target = path.join(root, '.hatch', ...file.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.contentBase64, 'base64'), {
          flag: 'wx',
        });
      }
    },
    async tooling({ native }) {
      return {
        ...request.tooling,
        nsh: native ? request.tooling.nsh : null,
        sdk: sdkFilesDigest(sdkFiles),
      };
    },
    nsh() {
      const version = request.tooling.nsh;
      if (!version) {
        throw Object.assign(
          new Error('This platform does not build native frontends.'),
          { code: 'nsh_unavailable' },
        );
      }
      const binary = nshBinary(version);
      const nshEnv = {
        ...env,
        NSH_TSC: TSC,
        NSH_CACHE: path.join(os.homedir(), '.cache', 'hatch', 'nsh'),
        NO_COLOR: '1',
      };
      return {
        version,
        run: (args, { cwd, timeoutMs }) =>
          run(binary, args, { cwd, env: nshEnv, timeoutMs }),
        withSandboxOwnership: (_targets, task) => task(),
      };
    },
  };

  try {
    await buildAppSource(host, {
      appId: request.appId,
      deploymentId: request.deploymentId,
      commit: request.commit,
      sourceDir: request.sourceDir,
      outDir: request.outDir,
    });
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        code:
          error instanceof AppManifestValidationError
            ? 'APP_MANIFEST_INVALID'
            : code === 'nsh_unavailable'
              ? code
              : 'app_build_failed',
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 6;
  }
}

await main();
