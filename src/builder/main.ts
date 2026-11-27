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
import { createWriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { BUILD_WORK_DIR } from '~agent/paths';
import { withSandboxOwnership } from '~agent/shell-sandbox';
import { getBuilderEnv } from '~env';
import { packBuildDirectory } from '../app-build/archive';
import { buildAppSource } from '../app-build/produce';
import { platformBuildHost } from '../server/apps/build-host';
import { AppManifestValidationError } from '../server/apps/manifest-validation';
import { LogShipper } from './log-shipper';
import {
  boundFailureMessage,
  BUILD_TOKEN_HEADER,
  BUILDER_API_PREFIX,
  BUILDER_PROTOCOL_VERSION,
  HEARTBEAT_MS,
  LEASE_WAIT_MS,
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
  // Every tool of the build runs as the sandbox identity, with a home and a
  // pnpm store of this job's own (never a shared one another App's build
  // could have written), and the build copy is that identity's while it runs.
  const sandbox = {
    home: path.join(request.workDir, 'sandbox-home'),
    pnpmStoreDir: path.join(request.workDir, 'sandbox-store'),
  };
  await mkdir(sandbox.home, { recursive: true });
  await mkdir(sandbox.pnpmStoreDir, { recursive: true });
  const host = platformBuildHost({
    sdkDigest: request.sdkDigest,
    workDir: request.workDir,
    signal: stopping.signal,
    sandbox,
  });
  const owned: string[] = [];
  const isOwned = (target: string) =>
    owned.some((root) => target === root || target.startsWith(`${root}/`));
  host.withSource = async (src, task) => {
    const targets = [src, sandbox.home, sandbox.pnpmStoreDir];
    owned.push(...targets);
    try {
      return await withSandboxOwnership(targets, task);
    } finally {
      owned.length = 0;
    }
  };
  // A nested hand-over (the native build's) only adds what is not already
  // the sandbox's, so it never gives the build copy back mid-build.
  const nshHost = host.nsh.bind(host);
  host.nsh = () => {
    const nsh = nshHost();
    return {
      ...nsh,
      withSandboxOwnership: (targets, task) =>
        withSandboxOwnership(
          targets.filter((target) => !isOwned(target)),
          task,
        ),
    };
  };
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
/** How long a finished build waits for its queued output to be sent. */
const LOG_DRAIN_MS = 30_000;
/** Largest source archive a Builder downloads. */
const SOURCE_MAX_BYTES = 1024 * 1024 * 1024;

type CallInit = RequestInit & {
  build?: LeasedBuild;
  timeoutMs?: number;
};

/** Write a response body to `file`, at most `limit` bytes of it. */
async function saveBody(
  response: Response,
  file: string,
  limit: number,
): Promise<void> {
  if (!response.body) throw new Error('The source download has no body.');
  let received = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        callback(new Error('The source archive is larger than expected.'));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream),
    cap,
    createWriteStream(file),
  );
}

async function startBuilder(): Promise<void> {
  const config = getBuilderEnv();
  // Aborted on SIGTERM/SIGINT: ends the lease wait and every running build.
  const shutdown = new AbortController();

  /**
   * Fetch from the platform within `timeoutMs`, body included. With
   * `onBody`, the body is not buffered: `onBody` consumes it under the same
   * deadline and signal, and the response is returned with its body used.
   */
  async function call(
    pathname: string,
    init: CallInit & {
      onBody?: (response: Response) => Promise<void>;
    } = {},
  ): Promise<Response> {
    const { build, timeoutMs = CALL_TIMEOUT_MS, onBody, ...rest } = init;
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
    if (onBody && response.ok) {
      await onBody(response);
      return response;
    }
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
        concurrency: config.concurrency,
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
    const logs = new LogShipper((lines, signal) =>
      call(`/${build.id}/logs`, {
        method: 'POST',
        build,
        signal,
        body: JSON.stringify({ lines }),
      }),
    );
    /**
     * Record the build's failure with the platform; never throws. A message
     * past the report's limit is cut there, so the build log gets it whole.
     */
    const reportFailure = async (message: string, code?: string) => {
      const reported = boundFailureMessage(message);
      if (reported !== message) {
        // In pieces the log keeps whole (it cuts longer lines).
        const pieces = message.split('\n').flatMap((line) =>
          Array.from(
            {
              length: Math.max(1, Math.ceil(line.length / LOG_LINE_MAX_CHARS)),
            },
            (_, piece) =>
              line.slice(
                piece * LOG_LINE_MAX_CHARS,
                (piece + 1) * LOG_LINE_MAX_CHARS,
              ),
          ),
        );
        const deadline = AbortSignal.any([
          AbortSignal.timeout(LOG_DRAIN_MS),
          stop.signal,
        ]);
        await logs.pushPaced(
          ['[builder] The build failed:', ...pieces],
          deadline,
        );
        await logs.drain(LOG_DRAIN_MS, stop.signal);
      }
      if (stop.signal.aborted) return;
      const response = await call(`/${build.id}/fail`, {
        method: 'POST',
        build,
        body: JSON.stringify({ message: reported, code }),
      }).catch((error: unknown) => {
        console.error(`[builder] ${build.id}: failure report failed:`, error);
        return null;
      });
      if (!response || response.ok) return;
      // 409: the lease moved on (canceled, or expired and leased again).
      const reason = await response.text().catch(() => '');
      console.error(
        `[builder] ${build.id}: the platform did not record the failure ` +
          `(${response.status}) ${reason}`,
      );
    };
    let work: string | undefined;
    try {
      await mkdir(BUILD_WORK_DIR, { recursive: true });
      work = await mkdtemp(path.join(BUILD_WORK_DIR, `builder-${build.id}-`));
      // mkdtemp makes it 0700. App code runs as the sandbox identity on
      // directories below (the source it owns, the native check's scratch),
      // so that identity must be able to pass through, though not list it.
      await chmod(work, 0o711);
      const archive = path.join(work, 'source.tar.gz');
      // Streamed to disk: the archive may be large.
      const source = await call(`/${build.id}/source`, {
        build,
        signal: stop.signal,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        onBody: (response) => saveBody(response, archive, SOURCE_MAX_BYTES),
      });
      if (!source.ok) {
        // The platform names why (a source over its budget, say).
        const reason = (
          (await source.json().catch(() => ({}))) as { error?: unknown }
        ).error;
        throw new Error(
          `Source download failed (${source.status})` +
            (typeof reason === 'string' ? `: ${reason}` : '.'),
        );
      }
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
      // Bounded: a slow log endpoint must not keep the package from the
      // platform (nor a stopped build from ending).
      await logs.drain(LOG_DRAIN_MS, stop.signal);
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
        await reportFailure(
          result.message ?? 'The build stopped without a result.',
          result.code,
        );
        return;
      }
      const packaged = new Uint8Array(await packBuildDirectory(outDir));
      stop.signal.throwIfAborted();
      // Stopped with the run: a canceled deployment's upload ends at once.
      // The platform's lease ends too once it has the package (it verifies
      // and releases it, and settles the deployment either way), so a
      // stopped wait for its answer is no failure.
      const uploaded = await call(`/${build.id}/artifact`, {
        method: 'PUT',
        build,
        signal: stop.signal,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: { 'content-type': 'application/gzip' },
        body: packaged,
      }).catch((error: unknown) => {
        if (stop.signal.aborted) {
          console.log(
            `[builder] ${build.id}: ` +
              (leaseLost
                ? 'lease ended during the upload (the platform has the ' +
                  'package, or the build was canceled)'
                : 'stopped during the upload'),
          );
        } else {
          console.error(`[builder] ${build.id}: upload did not finish:`, error);
        }
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
      await logs.drain(LOG_DRAIN_MS, stop.signal);
      await reportFailure(
        error instanceof Error ? error.message : String(error),
      );
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
