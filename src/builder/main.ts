/**
 * Builder entry point: the optional dedicated service that builds App
 * deployments (src/builder/protocol.ts).
 *
 * It holds no database credentials and no platform secret besides its own
 * token, but it is trusted like the platform: the frontends it builds run as
 * the signed-in user while App pages share the platform's origin
 * (docs/app-builds.md). It leases a queued build, downloads the commit, builds it in a
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
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
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
  LEASE_WAIT_MS,
  LOG_BATCH_MAX_BYTES,
  LOG_BATCH_MAX_LINES,
  LOG_FLUSH_MS,
  LOG_LINE_MAX_CHARS,
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
  // The Builder stops a job with SIGTERM: every tool it started (each in its
  // own process group, outside the job's) is stopped first, then the job
  // exits; the Builder kills what remains after a grace period.
  const stopping = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => stopping.abort());
  }
  const request = JSON.parse(await readFile(file, 'utf8')) as JobRequest;
  const host = platformBuildHost({
    sdkDigest: request.sdkDigest,
    workDir: request.workDir,
    signal: stopping.signal,
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

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Default deadline of one call to the platform, body read included. */
const CALL_TIMEOUT_MS = 60_000;
/** An upload may carry up to the package limit over a slow link. */
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
/** How long a stopping Builder lets its builds wind down. */
const SHUTDOWN_GRACE_MS = 20_000;
/** How long a stopped job has to stop its tools before it is killed. */
const JOB_STOP_GRACE_MS = 10_000;
const LOG_SEND_ATTEMPTS = 3;

type CallInit = RequestInit & {
  build?: LeasedBuild;
  timeoutMs?: number;
};

/**
 * Build output on its way to the platform: sent one batch at a time, in
 * order, each within the protocol's line and byte limits; a failed batch is
 * retried a few times, then dropped with a note, so a broken log endpoint
 * cannot hold up the build.
 */
class LogShipper {
  private queue: string[] = [];
  private sending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly send: (lines: string[]) => Promise<Response>) {}

  push(lines: readonly string[]): void {
    if (this.stopped) return;
    for (const line of lines) {
      this.queue.push(
        line.length > LOG_LINE_MAX_CHARS
          ? `${line.slice(0, LOG_LINE_MAX_CHARS - 1)}…`
          : line,
      );
    }
  }

  /** Send what is queued now; resolves when it (and earlier sends) landed. */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length > 0 && !this.stopped) {
        await this.sendBatch(this.takeBatch());
      }
    });
    return this.sending;
  }

  private takeBatch(): string[] {
    // `{"lines":[]}` plus each JSON string and its comma.
    let bytes = 12;
    let count = 0;
    while (count < this.queue.length && count < LOG_BATCH_MAX_LINES) {
      const size = Buffer.byteLength(JSON.stringify(this.queue[count])) + 1;
      if (count > 0 && bytes + size > LOG_BATCH_MAX_BYTES) break;
      bytes += size;
      count += 1;
    }
    return this.queue.splice(0, count);
  }

  private async sendBatch(lines: string[]): Promise<void> {
    for (let attempt = 1; attempt <= LOG_SEND_ATTEMPTS; attempt++) {
      const response = await this.send(lines).catch(() => null);
      if (response?.ok) return;
      if (response?.status === 409) {
        // The lease moved on; nothing more is accepted for this build.
        this.stopped = true;
        this.queue = [];
        return;
      }
      if (response && response.status >= 400 && response.status < 500) break;
      await sleep(500 * attempt);
    }
    console.error(`[builder] dropped ${lines.length} build log line(s)`);
  }
}

async function startBuilder(): Promise<void> {
  const config = getBuilderEnv();
  // Aborted on SIGTERM/SIGINT: ends the lease wait and every running build.
  const shutdown = new AbortController();

  async function call(
    pathname: string,
    init: CallInit = {},
  ): Promise<Response> {
    const { build, timeoutMs = CALL_TIMEOUT_MS, ...rest } = init;
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(rest.signal ? [rest.signal] : []),
    ]);
    const response = await fetch(
      `${config.platformUrl}${BUILDER_API_PREFIX}${pathname}`,
      {
        ...rest,
        signal,
        headers: {
          authorization: `Bearer ${config.token}`,
          ...(build ? { [BUILD_TOKEN_HEADER]: build.token } : {}),
          ...(rest.body && !(rest.body instanceof Uint8Array)
            ? { 'content-type': 'application/json' }
            : {}),
          ...rest.headers,
        },
      },
    );
    // The deadline covers the body too: read it now, under the same signal.
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }

  async function lease(): Promise<LeasedBuild | null> {
    const response = await call('/lease', {
      method: 'POST',
      signal: shutdown.signal,
      timeoutMs: LEASE_WAIT_MS + CALL_TIMEOUT_MS,
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
    // Ends the build: a cancellation, a lost lease, or the Builder stopping.
    const stop = new AbortController();
    const onShutdown = () => stop.abort();
    shutdown.signal.addEventListener('abort', onShutdown, { once: true });
    let leaseLost = false;
    let renewing = false;
    // The lease is renewed from the moment this run owns the build until the
    // platform has its package (verifying) or its failure, so neither a slow
    // source download nor packing and uploading can let it expire.
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        const response = await call(`/${build.id}/heartbeat`, {
          method: 'POST',
          build,
        }).catch(() => null);
        if (!response) return;
        const body = (await response.json().catch(() => ({}))) as {
          continue?: boolean;
        };
        if (body.continue === false) {
          leaseLost = true;
          stop.abort();
        }
      } finally {
        renewing = false;
      }
    }, HEARTBEAT_MS);
    const logs = new LogShipper((lines) =>
      call(`/${build.id}/logs`, {
        method: 'POST',
        build,
        body: JSON.stringify({ lines }),
      }),
    );
    let work: string | undefined;
    try {
      await mkdir(BUILD_WORK_DIR, { recursive: true });
      work = await mkdtemp(path.join(BUILD_WORK_DIR, `builder-${build.id}-`));
      // mkdtemp makes it 0700. App code runs as the sandbox identity on
      // directories below (the source it owns, the native check's scratch),
      // so that identity must be able to pass through, though not list it.
      await chmod(work, 0o711);
      const source = await call(`/${build.id}/source`, {
        build,
        signal: stop.signal,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
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
      stop.signal.throwIfAborted();

      // `process.execArgv` keeps a development loader (tsx) for the job;
      // the bundled Builder has none.
      const job = spawn(
        process.execPath,
        [...process.execArgv, process.argv[1]!, '--job', requestFile],
        {
          cwd: process.cwd(),
          env: jobEnvironment(),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const killGroup = () => {
        try {
          if (job.pid) process.kill(-job.pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      };
      let forced: NodeJS.Timeout | undefined;
      // Ask the job to stop its tools, then kill what is left of it.
      const kill = () => {
        try {
          job.kill('SIGTERM');
        } catch {
          /* already stopped */
        }
        forced = setTimeout(killGroup, JOB_STOP_GRACE_MS);
      };
      stop.signal.addEventListener('abort', kill, { once: true });
      let stdout = '';
      let carry = '';
      job.stdout.setEncoding('utf8');
      job.stdout.on('data', (data) => (stdout += data));
      job.stderr.setEncoding('utf8');
      job.stderr.on('data', (data: string) => {
        const lines = (carry + data).split('\n');
        carry = lines.pop() ?? '';
        logs.push(lines);
      });
      const flusher = setInterval(() => void logs.flush(), LOG_FLUSH_MS);
      const exited = await new Promise<Error | null>((resolve) => {
        job.once('error', (error) => resolve(error));
        job.once('close', () => resolve(null));
      });
      clearInterval(flusher);
      clearTimeout(forced);
      stop.signal.removeEventListener('abort', kill);
      // Nothing of the job outlives it.
      killGroup();
      if (carry) logs.push([carry]);
      await logs.flush();
      if (stop.signal.aborted) {
        console.log(
          `[builder] ${build.id}: ${leaseLost ? 'lease ended' : 'stopped'}`,
        );
        return;
      }
      if (exited)
        throw new Error(`Could not start the build: ${exited.message}`);
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
      const packaged = new Uint8Array(await packBuildDirectory(outDir));
      stop.signal.throwIfAborted();
      const uploaded = await call(`/${build.id}/artifact`, {
        method: 'PUT',
        build,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: { 'content-type': 'application/gzip' },
        body: packaged,
      }).catch((error) => {
        // Once sent, the platform settles the deployment either way.
        console.error(`[builder] ${build.id}: upload did not finish:`, error);
        return null;
      });
      if (!uploaded) return;
      const final = (await uploaded.json().catch(() => ({}))) as {
        status?: string;
      };
      console.log(`[builder] ${build.id}: ${final.status ?? uploaded.status}`);
    } catch (error) {
      if (stop.signal.aborted) return;
      console.error(`[builder] ${build.id} failed:`, error);
      await logs.flush();
      await call(`/${build.id}/fail`, {
        method: 'POST',
        build,
        body: JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        }),
      }).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      shutdown.signal.removeEventListener('abort', onShutdown);
      if (work) await rm(work, { recursive: true, force: true });
    }
  }

  async function slot(): Promise<void> {
    while (!shutdown.signal.aborted) {
      try {
        const build = await lease();
        if (build) await run(build);
      } catch (error) {
        if (shutdown.signal.aborted) return;
        console.error('[builder] lease failed:', error);
        await sleep(5_000, shutdown.signal);
      }
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      // Stop claiming work and stop every running build (its job's process
      // group included); each run removes its scratch directory. Their
      // deployments' leases expire and they are queued again.
      shutdown.abort();
      setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
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
