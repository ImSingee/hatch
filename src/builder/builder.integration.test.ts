/**
 * Opt-in end-to-end contract of the dedicated Builder: the production
 * platform with HATCH_BUILDER_TOKEN, a real Builder process and the packed
 * CLI. Requires `pnpm build` and a disposable PostgreSQL server
 * (HATCH_BUILDER_TEST_DATABASE_URL, an admin URL; the suite creates its own
 * database).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.HATCH_BUILDER_TEST_DATABASE_URL;
const cliExecutable = fileURLToPath(
  new URL('../../packages/hatch-cli/dist/main.mjs', import.meta.url),
);
const secret = 'disposable-builder-test-secret-32-characters';
const builderToken = 'disposable-builder-token';
let root: string;
let origin: string;
let sessionToken: string;
let platform: ChildProcess;
let builder: ChildProcess | undefined;
/** Settles when the current Builder exits, however early. */
let builderExit: Promise<unknown> = Promise.resolve();
let databaseUrl: string;
/** The database this suite created, dropped again in teardown. */
let createdDatabase: string | undefined;
let platformLog = '';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let internalPort = 0;

function startBuilder(): ChildProcess {
  const child = spawn(process.execPath, ['dist/builder/main.mjs'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // This host cannot switch to the sandbox identity.
      HATCH_ALLOW_UNSANDBOXED: 'true',
      HATCH_PLATFORM_URL: `http://127.0.0.1:${internalPort}`,
      HATCH_BUILDER_TOKEN: builderToken,
      HATCH_BUILDER_ID: 'builder-test',
      HATCH_DATA_DIR: path.join(root, 'builder'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data) => (platformLog += `[builder] ${data}`));
  child.stderr?.on('data', (data) => (platformLog += `[builder] ${data}`));
  builderExit = once(child, 'close');
  return child;
}

async function cli(args: string[]) {
  const child = spawn(process.execPath, [cliExecutable, ...args, '--json'], {
    cwd: root,
    env: {
      ...process.env,
      HATCH_CLI_URL: origin,
      HATCH_CLI_TOKEN: sessionToken,
      HATCH_CLI_API_KEY: undefined,
      HATCH_BUILD_TOOLCHAIN_DIR: process.cwd(),
      FORCE_COLOR: undefined,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (data) => (stdout += data));
  child.stderr.setEncoding('utf8').on('data', (data) => (stderr += data));
  const [code] = (await once(child, 'close')) as [number];
  return { code, data: stdout ? JSON.parse(stdout) : null, stderr };
}

function commit(directory: string, message: string) {
  execFileSync('git', ['-C', directory, 'add', '-A']);
  execFileSync('git', [
    '-C',
    directory,
    '-c',
    'user.name=Builder test',
    '-c',
    'user.email=builder@example.test',
    'commit',
    '--allow-empty',
    '-m',
    message,
  ]);
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

describe.runIf(Boolean(adminUrl))('the dedicated Builder', () => {
  let appId: string;
  let directory: string;

  beforeAll(async () => {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'hatch-builder-')),
    );
    const database = `builder_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(adminUrl!);
    try {
      await admin.unsafe(`create database ${database}`);
      createdDatabase = database;
    } finally {
      await admin.end();
    }
    const url = new URL(adminUrl!);
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    // The platform answers before its own startup migrations finish.
    const client = postgres(databaseUrl, { onnotice: () => {} });
    try {
      await migrate(drizzle({ client }), { migrationsFolder: 'migrations' });
    } finally {
      await client.end();
    }
    const port = await freePort();
    internalPort = await freePort();
    origin = `http://127.0.0.1:${port}`;
    platform = spawn(process.execPath, ['dist/platform/server/index.mjs'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HATCH_ALLOW_UNSANDBOXED: 'true',
        DATABASE_URL: databaseUrl,
        APP_DATABASE_URL: databaseUrl,
        APP_URL: origin,
        SECRET: secret,
        HATCH_DATA_DIR: path.join(root, 'platform'),
        HOST: '127.0.0.1',
        PORT: String(port),
        AGENT_INTERNAL_HOST: '127.0.0.1',
        AGENT_INTERNAL_PORT: String(internalPort),
        AGENT_RUNNER_TOKEN: 'disposable-runner-token',
        HATCH_BUILDER_TOKEN: builderToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    platform.stdout?.on('data', (data) => (platformLog += data));
    platform.stderr?.on('data', (data) => (platformLog += data));
    for (let attempt = 0; attempt < 200; attempt++) {
      if (platform.exitCode !== null)
        throw new Error(`Platform exited: ${platformLog}`);
      if (
        await fetch(`${origin}/api/auth/ok`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        email: `${randomUUID()}@builder.test`,
        name: 'Builder owner',
        password: 'disposable-builder-password',
      }),
    });
    const signupText = await signup.text();
    assert.equal(signup.status, 200, `${signupText}\n${platformLog}`);
    // The sign-up session token is a valid CLI credential.
    sessionToken = (JSON.parse(signupText) as { token: string }).token;
    assert.ok(sessionToken, 'Sign-up returned no session token.');

    builder = startBuilder();
    directory = path.join(root, 'app');
    const file = path.join(root, 'create.json');
    await writeFile(
      file,
      JSON.stringify({
        slug: `built-${Date.now()}`,
        name: 'Built',
        pin: false,
      }),
    );
    const created = await cli([
      'app',
      'create',
      '--file',
      file,
      '--directory',
      directory,
    ]);
    assert.equal(created.code, 0, JSON.stringify(created));
    appId = created.data.id;
  }, 240_000);

  afterAll(async () => {
    builder?.kill('SIGKILL');
    await builderExit;
    if (platform && platform.exitCode === null) {
      const exited = once(platform, 'close');
      platform.kill('SIGKILL');
      await exited;
    }
    if (root) await rm(root, { recursive: true, force: true });
    if (createdDatabase) {
      const admin = postgres(adminUrl!);
      try {
        await admin.unsafe(
          `drop database if exists ${createdDatabase} with (force)`,
        );
      } finally {
        await admin.end();
      }
    }
  });

  it('builds on the Builder, streams its log and releases the package', async () => {
    const deployed = await cli([
      'app',
      'deploy',
      '--directory',
      directory,
      '--message',
      'First build on the Builder',
      '--timeout',
      '600',
    ]);
    assert.equal(
      deployed.code,
      0,
      `${JSON.stringify(deployed)}\n${platformLog}`,
    );
    expect(deployed.data).toMatchObject({
      status: 'ready',
      build: 'builder',
      version: 1,
    });
    // The Builder's own output reached the CLI as it ran.
    expect(deployed.stderr).toContain('Building on builder-test');
    expect(deployed.stderr).toMatch(/bundled backend/);
    const logs = await cli([
      'app',
      'deployments',
      'logs',
      appId,
      deployed.data.deploymentId,
    ]);
    expect(
      logs.data.lines.some(
        (line: { stream: string }) => line.stream === 'build',
      ),
    ).toBe(true);
  }, 600_000);

  it('queues while no Builder runs, cancels and supersedes', async () => {
    // Stopped here, or already gone (its output says why).
    builder?.kill('SIGKILL');
    await builderExit;
    builder = undefined;
    await writeFile(path.join(directory, 'note.txt'), 'second');
    commit(directory, 'Second');
    const queued = await cli([
      'app',
      'deploy',
      '--directory',
      directory,
      '--message',
      'Queued',
      '--no-wait',
    ]);
    assert.equal(queued.code, 0, JSON.stringify(queued));
    expect(queued.data.status).toBe('queued');
    const canceled = await cli([
      'app',
      'deployments',
      'cancel',
      appId,
      queued.data.deploymentId,
      '--yes',
    ]);
    expect(canceled.data.status).toBe('canceled');
    // A canceled deployment no longer blocks the checkout.
    await writeFile(path.join(directory, 'note.txt'), 'third');
    commit(directory, 'Third');
    const first = await cli([
      'app',
      'deploy',
      '--directory',
      directory,
      '--message',
      'Superseded',
      '--no-wait',
    ]);
    const second = await cli([
      'app',
      'deploy',
      '--directory',
      directory,
      '--message',
      'Newest',
      '--local',
      '--retry-after-confirming',
      first.data.commit,
    ]);
    assert.equal(second.code, 0, JSON.stringify(second));
    expect(second.data).toMatchObject({ status: 'ready', build: 'local' });
    const older = await cli([
      'app',
      'deployments',
      'get',
      appId,
      first.data.deploymentId,
    ]);
    expect(older.data.status).toBe('superseded');
    const listed = await cli(['app', 'deployments', 'list', appId]);
    expect(
      listed.data.deployments.map((item: { status: string }) => item.status),
    ).toEqual(['ready', 'superseded', 'canceled', 'ready']);
  }, 600_000);

  it('refuses the Builder API to anyone without its token', async () => {
    const response = await fetch(
      `http://127.0.0.1:${internalPort}/internal/api/builds/lease`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer disposable-runner-token' },
        body: JSON.stringify({ builderId: 'x', protocolVersion: 1 }),
      },
    );
    expect(response.status).toBe(401);
  });
});
