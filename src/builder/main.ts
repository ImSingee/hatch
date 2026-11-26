/**
 * Builder entry point: the optional dedicated service that builds App
 * deployments (src/builder/protocol.ts).
 *
 * It holds no database credentials and no platform secret besides its own
 * token. It leases a queued build, downloads the commit, builds it in a
 * child process that runs App code under the sandbox identity, streams the
 * output, and uploads the build package, which the platform checks and
 * releases. Several Builders (and BUILDER_CONCURRENCY builds each) can run
 * at once.
 *
 * Environment:
 *   HATCH_PLATFORM_URL   platform internal base URL (default http://127.0.0.1:3701)
 *   HATCH_BUILDER_TOKEN  shared bearer secret (required)
 *   HATCH_BUILDER_ID     stable Builder identity (default builder-<hostname>)
 *   BUILDER_CONCURRENCY  builds at once (default 1)
 *   HATCH_DATA_DIR       scratch root for builds (see ~agent/paths)
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUILD_WORK_DIR } from '~agent/paths';
import { getBuilderEnv } from '~env';
import { packBuildDirectory } from '../app-build/archive';
import { buildAppSource } from '../app-build/produce';
import { platformBuildHost } from '../server/apps/build-host';
import { AppManifestValidationError } from '../server/apps/manifest-validation';
import {
  BUILD_TOKEN_HEADER,
  BUILDER_API_PREFIX,
  BUILDER_PROTOCOL_VERSION,
  HEARTBEAT_MS,
  LOG_FLUSH_MS,
  type LeasedBuild,
} from './protocol';

type JobRequest = {
  appId: string;
  deploymentId: string;
  commit: string;
  sourceDir: string;
  outDir: string;
  workDir: string;
  sdkDigest: string;
};

/** `--job <request>`: build one source tree; the parent talks to the platform. */
async function runJob(file: string): Promise<void> {
  const request = JSON.parse(await readFile(file, 'utf8')) as JobRequest;
  const host = platformBuildHost({
    sdkDigest: request.sdkDigest,
    workDir: request.workDir,
  });
  const toolchainContext = host.toolchainContext;
  host.toolchainContext = (root, logs) => {
    // Stream the build to the parent as it runs.
    const push = logs.push.bind(logs);
    logs.push = (...items: string[]) => {
      for (const item of items) process.stderr.write(`${item}\n`);
      return push(...items);
    };
    return toolchainContext(root, logs);
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
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        code:
          error instanceof AppManifestValidationError
            ? 'APP_MANIFEST_INVALID'
            : 'app_build_failed',
        message: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
}

/** Environment of a build job: never the Builder's token. */
function jobEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'NODE_ENV',
    'HATCH_DATA_DIR',
    'HATCH_ALLOW_UNSANDBOXED',
    'HATCH_NSH_BIN',
    'HATCH_PNPM_STORE_DIR',
    'DENO_DIR',
    'XDG_CACHE_HOME',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function startBuilder(): Promise<void> {
  const config = getBuilderEnv();
  let stopping = false;

  async function call(
    pathname: string,
    init: RequestInit & { build?: LeasedBuild } = {},
  ): Promise<Response> {
    const { build, ...rest } = init;
    return fetch(`${config.platformUrl}${BUILDER_API_PREFIX}${pathname}`, {
      ...rest,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(build ? { [BUILD_TOKEN_HEADER]: build.token } : {}),
        ...(rest.body && !(rest.body instanceof Uint8Array)
          ? { 'content-type': 'application/json' }
          : {}),
        ...rest.headers,
      },
    });
  }

  async function lease(): Promise<LeasedBuild | null> {
    const response = await call('/lease', {
      method: 'POST',
      body: JSON.stringify({
        builderId: config.builderId,
        protocolVersion: BUILDER_PROTOCOL_VERSION,
      }),
    });
    if (response.status === 409) {
      const body = (await response.json()) as { protocolVersion?: number };
      throw new Error(
        `The platform speaks Builder protocol ${body.protocolVersion}; this ` +
          `Builder speaks ${BUILDER_PROTOCOL_VERSION}. Run the same release.`,
      );
    }
    if (!response.ok) throw new Error(`Lease failed: ${response.status}`);
    return ((await response.json()) as { build: LeasedBuild | null }).build;
  }

  async function run(build: LeasedBuild): Promise<void> {
    await mkdir(BUILD_WORK_DIR, { recursive: true });
    const work = await mkdtemp(
      path.join(BUILD_WORK_DIR, `builder-${build.id}-`),
    );
    let pending: string[] = [];
    let carry = '';
    let canceled = false;
    const flush = async () => {
      if (pending.length === 0) return;
      const lines = pending.splice(0, 5_000);
      await call(`/${build.id}/logs`, {
        method: 'POST',
        build,
        body: JSON.stringify({ lines }),
      }).catch(() => {
        pending = [...lines, ...pending];
      });
    };
    try {
      const source = await call(`/${build.id}/source`, { build });
      if (!source.ok)
        throw new Error(`Source download failed: ${source.status}`);
      const archive = path.join(work, 'source.tar.gz');
      await writeFile(archive, Buffer.from(await source.arrayBuffer()));
      const sourceDir = path.join(work, 'source');
      await mkdir(sourceDir);
      await new Promise<void>((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', archive, '-C', sourceDir], {
          stdio: 'ignore',
        });
        tar.once('error', reject);
        tar.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error('Could not unpack the source.')),
        );
      });
      const outDir = path.join(work, 'package');
      const request: JobRequest = {
        appId: build.appId,
        deploymentId: build.id,
        commit: build.commit,
        sourceDir,
        outDir,
        workDir: path.join(work, 'scratch'),
        sdkDigest: build.sdkDigest,
      };
      await mkdir(request.workDir);
      const requestFile = path.join(work, 'request.json');
      await writeFile(requestFile, JSON.stringify(request));

      const job = spawn(
        process.execPath,
        [process.argv[1]!, '--job', requestFile],
        {
          cwd: process.cwd(),
          env: jobEnvironment(),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const kill = () => {
        try {
          if (job.pid) process.kill(-job.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      };
      let stdout = '';
      job.stdout.setEncoding('utf8');
      job.stdout.on('data', (data) => (stdout += data));
      job.stderr.setEncoding('utf8');
      job.stderr.on('data', (data: string) => {
        const lines = (carry + data).split('\n');
        carry = lines.pop() ?? '';
        pending.push(...lines);
      });
      const flusher = setInterval(() => void flush(), LOG_FLUSH_MS);
      const heartbeat = setInterval(async () => {
        const response = await call(`/${build.id}/heartbeat`, {
          method: 'POST',
          build,
        }).catch(() => null);
        if (!response) return;
        const body = (await response.json().catch(() => ({}))) as {
          continue?: boolean;
        };
        if (body.continue === false) {
          canceled = true;
          kill();
        }
      }, HEARTBEAT_MS);
      await new Promise<void>((resolve) => job.once('close', () => resolve()));
      clearInterval(flusher);
      clearInterval(heartbeat);
      if (carry) pending.push(carry);
      await flush();
      if (canceled) return;
      const result = JSON.parse(stdout.trim().split('\n').at(-1) || '{}') as {
        ok?: boolean;
        code?: string;
        message?: string;
      };
      if (!result.ok) {
        await call(`/${build.id}/fail`, {
          method: 'POST',
          build,
          body: JSON.stringify({
            message: result.message ?? 'The build stopped without a result.',
            code: result.code,
          }),
        });
        return;
      }
      const uploaded = await call(`/${build.id}/artifact`, {
        method: 'PUT',
        build,
        headers: { 'content-type': 'application/gzip' },
        body: new Uint8Array(await packBuildDirectory(outDir)),
      });
      const final = (await uploaded.json().catch(() => ({}))) as {
        status?: string;
      };
      console.log(`[builder] ${build.id}: ${final.status ?? uploaded.status}`);
    } catch (error) {
      console.error(`[builder] ${build.id} failed:`, error);
      await call(`/${build.id}/fail`, {
        method: 'POST',
        build,
        body: JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        }),
      }).catch(() => {});
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async function slot(): Promise<void> {
    while (!stopping) {
      try {
        const build = await lease();
        if (build) await run(build);
      } catch (error) {
        console.error('[builder] lease failed:', error);
        await sleep(5_000);
      }
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stopping = true;
      // Builds in progress lose their lease and are queued again.
      process.exit(0);
    });
  }
  console.log(
    `[builder] ${config.builderId} building from ${config.platformUrl} ` +
      `(${config.concurrency} at once)`,
  );
  await Promise.all(Array.from({ length: config.concurrency }, () => slot()));
}

const jobIndex = process.argv.indexOf('--job');
if (jobIndex !== -1) await runJob(process.argv[jobIndex + 1]!);
else await startBuilder();
