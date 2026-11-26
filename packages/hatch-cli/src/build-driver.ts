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
import { access, readFile } from 'node:fs/promises';
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
import { writeFiles } from './workspace';

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

/** A tool the build needs is missing or not the platform's version. */
function toolUnavailable(message: string): Error {
  return Object.assign(new Error(message), { code: 'tool_unavailable' });
}

/**
 * The `deno` executable on PATH, as an absolute path. Tools run without a
 * shell, so on Windows only `deno.exe` counts: a `deno.cmd` or `.bat` shim
 * cannot be started without a command interpreter.
 */
function denoOnPath(env: NodeJS.ProcessEnv): string | null {
  const name = process.platform === 'win32' ? 'deno.exe' : 'deno';
  const search = Object.entries(env).find(
    ([key]) => key.toUpperCase() === 'PATH',
  )?.[1];
  for (const dir of (search ?? '').split(path.delimiter)) {
    const directory = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    const file = path.resolve(directory, name);
    if (executable(file)) return file;
  }
  return null;
}

/**
 * The pnpm that installs App dependencies: the platform's exact version,
 * from the toolchain (the cache installs it) or else PATH, never another
 * version recorded as the pinned one.
 */
async function pinnedPnpm(
  modules: string,
  version: string,
  env: NodeJS.ProcessEnv,
): Promise<{ executable: string; prefix: string[] }> {
  const installed = await readFile(
    path.join(modules, 'pnpm', 'package.json'),
    'utf8',
  )
    .then((text) => (JSON.parse(text) as { version?: string }).version)
    .catch(() => undefined);
  if (installed === version) {
    // pnpm's Node entry point (the cache installs it without its native
    // binary): bin/pnpm.mjs since pnpm 11, bin/pnpm.cjs before.
    for (const name of ['pnpm.mjs', 'pnpm.cjs']) {
      const entry = path.join(modules, 'pnpm', 'bin', name);
      if (
        await access(entry).then(
          () => true,
          () => false,
        )
      )
        return { executable: process.execPath, prefix: [entry] };
    }
  }
  const onPathPnpm = await pnpmInvocation(process.platform, env);
  const probe = spawnSync(
    onPathPnpm.executable,
    [...onPathPnpm.prefix, '--version'],
    // Outside any project, as the build's pnpm runs: a `packageManager`
    // field would make pnpm switch versions for the probe alone.
    { encoding: 'utf8', env, timeout: 30_000, cwd: os.tmpdir() },
  );
  const found = probe.status === 0 ? probe.stdout.trim() : undefined;
  if (found === version) return onPathPnpm;
  throw toolUnavailable(
    `The local build needs pnpm ${version}, the platform's version, but ` +
      (found ? `found ${found}.` : 'found none on PATH.') +
      ' Install it (for example `npm install --global pnpm@' +
      `${version}\`) or build on the platform with --build builder.`,
  );
}

async function main(): Promise<void> {
  // The CLI sends SIGTERM to cancel: every tool started below stops with it
  // (each runs in its own process group), before the CLI removes the work
  // directory they write to.
  const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => stopping.abort());
  }
  const request = requestSchema.parse(
    JSON.parse(await readFile(process.argv[2]!, 'utf8')),
  );
  const sdkFiles = z
    .array(z.object({ path: z.string(), contentBase64: z.string() }))
    .parse(JSON.parse(await readFile(request.sdkFiles, 'utf8')));
  const env = childEnvironment();
  const print = (text: string) => process.stderr.write(`${text}\n`);
  const modules = path.join(request.toolchainDir, 'node_modules');
  const TSC = path.join(modules, 'typescript', 'bin', 'tsc');
  // buf's bin entry is a Node script: run it with Node on every OS.
  const BUF = path.join(modules, '@bufbuild', 'buf', 'bin', 'buf');
  const bin = path.join(modules, '.bin');
  let pnpm: Promise<{ executable: string; prefix: string[] }> | undefined;
  const tool = (
    command: string,
    args: string[],
    options: Omit<Parameters<typeof run>[2], 'signal'>,
  ) => run(command, args, { ...options, signal: stopping.signal });

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
        async run({ tool: name, args, cwd, input, timeoutMs, env: extra }) {
          let command: string;
          let commandArgs: string[];
          if (name === 'tsc')
            [command, commandArgs] = [process.execPath, [TSC, ...args]];
          else if (name === 'node')
            [command, commandArgs] = [process.execPath, args];
          else if (name === 'pnpm') {
            pnpm ??= pinnedPnpm(modules, request.tooling.pnpm, env);
            const resolved = await pnpm;
            [command, commandArgs] = [
              resolved.executable,
              [...resolved.prefix, ...args],
            ];
          } else {
            const deno = denoOnPath(env);
            if (!deno)
              throw toolUnavailable(
                process.platform === 'win32'
                  ? 'Deno Apps build with deno.exe, which is not on PATH (a deno.cmd shim cannot run without a shell). Install Deno from https://deno.com, or build on the platform with --build builder.'
                  : 'Deno Apps build with deno, which is not on PATH. Install it from https://deno.com, or build on the platform with --build builder.',
              );
            [command, commandArgs] = [deno, args];
          }
          return tool(command, commandArgs, {
            cwd: cwd ?? root,
            env: { ...env, ...extra },
            input,
            timeoutMs,
          });
        },
      };
    },
    async runBuf(args, cwd) {
      // protoc-gen-es is found by buf on PATH, from the toolchain's bin.
      return tool(process.execPath, [BUF, ...args], {
        cwd,
        env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ''}` },
      });
    },
    async materializeSdk(root) {
      // The same path rules as a checkout's SDK files: nothing outside
      // `.hatch`, no repository or install directories, no duplicates.
      await writeFiles(path.join(root, '.hatch'), sdkFiles);
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
          tool(binary, args, { cwd, env: nshEnv, timeoutMs }),
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
        code: stopping.signal.aborted
          ? 'cancelled'
          : error instanceof AppManifestValidationError
            ? 'APP_MANIFEST_INVALID'
            : code === 'nsh_unavailable' || code === 'tool_unavailable'
              ? code
              : 'app_build_failed',
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 6;
  }
}

await main();
