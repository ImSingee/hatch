/**
 * Signed native packages on a real PostgreSQL server: the activation counter
 * grows in the transactions that make a deployment live, the instance's keys
 * are created once however many processes race, and the package and trust
 * RPCs serve every credential without exposing a private key. Built and
 * signed with the real pinned `nsh` and `hatch-nshpkg`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createConnectTransport } from '@connectrpc/connect-web';
import postgres from 'postgres';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PublicApiContext } from '../../platform-api/auth';
import {
  packageToolsAvailable,
  writePackageSource,
} from './test-fixtures/package-source';

const adminUrl = process.env.HATCH_POSTGRES_TEST_DATABASE_URL;

const fixture = vi.hoisted(() => ({
  credential: undefined as PublicApiContext | undefined,
}));
// Before any module reads it: every path of the platform (keys, artifacts,
// packages) is below this directory.
// Its real path: builds compare the paths esbuild resolves with it.
const dataDir = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = realpathSync(mkdtempSync(`${tmpdir()}/hatch-packages-pg-`));
  process.env.HATCH_DATA_DIR = dir;
  return dir;
});

// The App repository is not under test: releases record a tag, rollbacks
// move master to it.
vi.mock('../git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git')>()),
  publishDeploymentSource: async (
    _id: string,
    commit: string,
    version: number,
  ) => ({ tag: `deploy/v${version}`, commit, repoPath: '/repo' }),
  deleteDeploymentTag: async () => {},
  moveMasterToDeploymentTag: async () => 'a'.repeat(40),
}));
vi.mock('../../platform-api/auth', async () => {
  const { publicApiError } = await import('../../platform-api/errors');
  return {
    authenticatePublicApi: async () => {
      if (!fixture.credential) throw publicApiError('UNAUTHORIZED');
      return fixture.credential;
    },
  };
});

const user = { id: 'u1', email: 'owner@example.test', name: 'Owner' };
const CREDENTIALS: Record<string, PublicApiContext> = {
  session: {
    run: null,
    session: { id: 's1', expiresAt: new Date(Date.now() + 60_000) },
    status: {
      authenticated: true,
      credentialType: 'session',
      authority: 'platform',
      expiresAt: null,
      user,
    },
  },
  'api-key': {
    run: null,
    status: {
      authenticated: true,
      credentialType: 'api-key',
      authority: 'platform',
      expiresAt: null,
      user,
      key: { id: 'k1', name: null },
    },
  },
  run: {
    run: { runId: 'r1', sessionId: 'as1', runnerId: 'rn1' },
  } as PublicApiContext,
};

/** The public error code a call fails with, as the CLI reads it. */
async function failure(call: Promise<unknown>): Promise<string | null> {
  const { publicError } =
    await import('../../../../packages/hatch-cli/src/client');
  return call.then(
    () => null,
    (error: unknown) => publicError(error).code,
  );
}

type Verified = {
  ok: boolean;
  error?: string;
  app?: { build: number };
  capabilities?: unknown;
  files?: { path: string; kind: string; sha256: string }[];
};

describe.skipIf(!adminUrl || !packageToolsAvailable())(
  'Signed native packages on PostgreSQL',
  () => {
    const database = `hatch_packages_${process.pid}_${Date.now()}`;
    let admin: postgres.Sql;
    let platform: typeof import('~/db');
    let deploy: typeof import('../deploy');
    let manage: typeof import('../manage');
    let keys: typeof import('./signing-keys');
    let nshpkg: typeof import('./nshpkg');
    let build: typeof import('../build');
    let packages: typeof import('./packages');
    let nshConfig: typeof import('./nsh-config');
    /** The second "process" of the key race; closed at the end. */
    let otherDb: typeof import('~/db') | undefined;
    let client: ReturnType<
      typeof import('../../../../packages/hatch-cli/src/client').cliClient
    >;

    beforeAll(async () => {
      admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`create database "${database}"`);
      const target = new URL(adminUrl!);
      target.pathname = `/${database}`;
      vi.stubEnv('DATABASE_URL', target.toString());
      vi.stubEnv('SECRET', 'packages-test-secret-at-least-32-characters');
      vi.stubEnv('APP_URL', 'https://hatch.example.test');
      const { runMigrations } = await import('~/db/migrate');
      await runMigrations();
      platform = await import('~/db');
      deploy = await import('../deploy');
      manage = await import('../manage');
      keys = await import('./signing-keys');
      nshpkg = await import('./nshpkg');
      build = await import('../build');
      packages = await import('./packages');
      nshConfig = await import('./nsh-config');
      const { handlePlatformApiRequest } =
        await import('../../platform-api/http');
      const { cliClient } =
        await import('../../../../packages/hatch-cli/src/client');
      client = cliClient(
        createConnectTransport({
          baseUrl: 'https://hatch.example.test/api/rpc',
          useBinaryFormat: true,
          fetch: async (input, init) =>
            handlePlatformApiRequest(new Request(input, init)),
        }),
      );
    }, 120_000);

    afterAll(async () => {
      await platform?.db.$client.end({ timeout: 1 });
      await otherDb?.db.$client.end({ timeout: 1 });
      await admin?.unsafe(`drop database if exists "${database}" with (force)`);
      await admin?.end();
      await fs.rm(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }, 30_000);

    it('creates one key set however many processes race to create it', async () => {
      // Separate module instances stand for separate platform processes:
      // each has its own pool and no shared in-process state.
      vi.resetModules();
      const other = await import('./signing-keys');
      const states = await Promise.all([
        keys.ensureSigningKeys(),
        other.ensureSigningKeys(),
        keys.ensureSigningKeys(),
        other.ensureSigningKeys(),
      ]);
      expect(new Set(states.map((state) => state.rootKeyId)).size).toBe(1);
      expect(
        new Set(states.map((state) => state.activeReleaseKeyId)).size,
      ).toBe(1);
      const entries = await fs.readdir(dataDir);
      expect(entries.filter((name) => name.startsWith('keys'))).toEqual([
        'keys',
      ]);
      const dir = keys.signingKeysDir();
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
      const release = keys.activeReleaseKeyFiles(states[0]);
      for (const secret of [path.join(dir, 'root.secret'), release.secret]) {
        expect((await fs.stat(secret)).mode & 0o777).toBe(0o600);
      }
      otherDb = await import('~/db');
    }, 60_000);

    it('signs each activation with a new build: deploy, deploy, roll back', async () => {
      const appId = ulid().toLowerCase();
      await platform.db.insert(platform.schema.apps).values({
        id: appId,
        slug: 'package-demo',
        name: 'Package demo',
      });
      const { buildApp } = build;
      const built: Record<string, Awaited<ReturnType<typeof buildApp>>> = {};
      const artifacts: Record<string, string> = {};
      const deploymentIds = { A: ulid(), B: ulid() };
      for (const [label, deploymentId] of Object.entries(deploymentIds)) {
        const sourceDir = path.join(dataDir, `src-${label}`);
        await writePackageSource(sourceDir, {
          id: appId,
          name: 'Package demo',
          title: `Version ${label}`,
        });
        artifacts[label] = path.join(dataDir, `artifact-${label}`);
        built[label] = await buildApp(appId, {
          sourceDir,
          outputDir: artifacts[label],
          deploymentId,
        });
      }
      const release = (label: 'A' | 'B') =>
        deploy.releaseDeployment(appId, {
          deploymentId: deploymentIds[label],
          sourceCommit: 'a'.repeat(40),
          message: `Release ${label}`,
          buildOrigin: 'builder',
          produce: async (outputDir) => {
            await fs.cp(artifacts[label], outputDir, { recursive: true });
            return built[label];
          },
        });

      // Before any activation there is no package to get.
      fixture.credential = CREDENTIALS.session;
      expect(await failure(client.apps.nativePackage.get({ id: appId }))).toBe(
        'APP_NOT_DEPLOYED',
      );

      const files: string[] = [];
      const steps = [
        ['session', () => release('A')],
        ['api-key', () => release('B')],
        ['run', () => manage.rollbackAppToVersion(appId, 1)],
      ] as const;
      for (const [credential, activate] of steps) {
        await activate();
        // Every credential type may fetch it, the Agent's Run included.
        fixture.credential = CREDENTIALS[credential];
        const { package: description, bytes } =
          await client.apps.nativePackage.get({ id: appId });
        expect(description).toMatchObject({
          appId,
          build: files.length + 1,
          version: files.length === 2 ? 1 : files.length + 1,
          nshAppId: expect.stringMatching(/^dev\.hatch\.app\./),
          nshVersion: '0.7.0',
          size: bytes.length,
          bytecode: true,
        });
        const file = path.join(dataDir, `package-${files.length + 1}.nshpkg`);
        await fs.writeFile(file, bytes);
        files.push(file);
      }
      const app = await platform.db.query.apps.findFirst({
        where: { id: appId },
        columns: { activationSeq: true },
      });
      expect(app?.activationSeq).toBe(3);

      // A shell trusting the instance's root accepts all three in order.
      const trust = await client.apps.nativePackage.trust();
      const root = path.join(dataDir, 'trusted-root.pub');
      await fs.writeFile(root, trust.roots[0].publicKey);
      const revocations = path.join(dataDir, 'trusted-revocations.json');
      await fs.writeFile(revocations, trust.revocations!.signed);
      const { results } = await nshpkg.runNshpkg<{ results: Verified[] }>([
        'verify',
        '--root',
        root,
        '--revocations',
        revocations,
        '--state',
        path.join(dataDir, 'shell-trust'),
        ...files,
      ]);
      expect(results.map((result) => [result.ok, result.app?.build])).toEqual([
        [true, 1],
        [true, 2],
        [true, 3],
      ]);
      // The rollback ships version A's code byte for byte; B's differs.
      expect(results[2].files).toEqual(results[0].files);
      const source = (result: Verified) =>
        result.files?.find((file) => file.kind === 'source')?.sha256;
      expect(source(results[1])).not.toBe(source(results[0]));
      // Its capabilities are the platform's, whatever the build declared.
      for (const result of results) {
        expect(result.capabilities).toEqual(
          nshConfig.nativePackageCapabilities({ app: { runtime: 'native' } }),
        );
      }
      // An older build is refused once a newer one was accepted.
      const replay = await nshpkg.runNshpkg<{ results: Verified[] }>([
        'verify',
        '--root',
        root,
        '--state',
        path.join(dataDir, 'shell-trust'),
        files[1],
      ]);
      expect(replay.results[0]).toMatchObject({ ok: false });
      expect(replay.results[0].error).toContain('older than build 3');

      // An App that was never deployed has no package.
      const draftId = ulid().toLowerCase();
      await platform.db.insert(platform.schema.apps).values({
        id: draftId,
        slug: 'draft-demo',
        name: 'Draft demo',
      });
      await expect(packages.liveNativePackage(draftId)).rejects.toMatchObject({
        code: 'nativePackages.appNotDeployed',
      });
    }, 600_000);

    it('returns only public trust material to every credential', async () => {
      const dir = keys.signingKeysDir();
      const state = (await keys.readSigningKeys())!;
      const secrets = [
        (await fs.readFile(path.join(dir, 'root.secret'), 'utf8')).trim(),
        (
          await fs.readFile(keys.activeReleaseKeyFiles(state).secret, 'utf8')
        ).trim(),
      ];
      for (const credential of Object.values(CREDENTIALS)) {
        fixture.credential = credential;
        const trust = await client.apps.nativePackage.trust();
        expect(trust).toMatchObject({
          initialized: true,
          appIdPattern: 'dev.hatch.app.*',
          roots: [{ keyId: state.rootKeyId }],
          releaseKeys: [
            {
              keyId: state.activeReleaseKeyId,
              apps: ['dev.hatch.app.*'],
              active: true,
              revoked: false,
            },
          ],
          revocations: { sequence: 1, keyIds: [], packageSha256s: [] },
        });
        const text = JSON.stringify(trust);
        for (const secret of secrets) expect(text).not.toContain(secret);
      }
      fixture.credential = undefined;
      expect(await failure(client.apps.nativePackage.trust())).toBe(
        'UNAUTHORIZED',
      );
    }, 60_000);
  },
);
