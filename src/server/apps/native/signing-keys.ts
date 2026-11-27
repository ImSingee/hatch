/**
 * Server-only: the instance's package signing keys, in `HATCH_DATA_DIR/keys`.
 *
 * A root key certifies release keys and signs revocation lists; the active
 * release key signs every native App package. Native shells trust the root
 * (`GetAppRuntimeTrust`), so release keys can rotate under it. The set is
 * created when the first native deployment goes live, once per instance:
 * concurrent first creations, also on other platform processes sharing the
 * data directory, end with one set. Secret keys never leave this directory;
 * nothing here reads them except to hand their paths to `hatch-nshpkg`.
 *
 * Layout (written by `hatch-nshpkg keygen`, private to the platform user):
 *   state.json            the root, the active release key and every release key
 *   root.secret, root.pub
 *   release/<id>.secret, release/<id>.pub, release/<id>.cert
 *   revocations.json      the newest revocation list the root signed
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '~/db';
import { WORKSPACE_ROOT } from '~agent/paths';
import { runNshpkg } from './nshpkg';

export function signingKeysDir(): string {
  return path.join(WORKSPACE_ROOT, 'keys');
}

/** App ids the release key may sign for: every native App's `nshAppId`. */
export const NATIVE_APP_ID_PATTERN = 'dev.hatch.app.*';
/**
 * How long a release key may sign. A package stays valid after that (shells
 * check the signing time); a release key is rotated before it.
 */
const RELEASE_KEY_DAYS = 3650;
/** Advisory-lock namespace of the key set's creation. */
const SIGNING_KEYS_LOCK_NS = 11;

const releaseKeySchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  apps: z.array(z.string().min(1)).min(1),
  notBefore: z.number().int(),
  notAfter: z.number().int(),
  createdAt: z.number().int(),
});

const stateSchema = z.object({
  format: z.literal(1),
  rootKeyId: z.string().regex(/^[0-9a-f]{16}$/),
  activeReleaseKeyId: z.string().regex(/^[0-9a-f]{16}$/),
  releaseKeys: z.array(releaseKeySchema).min(1),
  revocationSequence: z.number().int().min(1),
});
export type SigningKeyState = z.infer<typeof stateSchema>;

async function readState(): Promise<SigningKeyState | null> {
  const text = await fs
    .readFile(path.join(signingKeysDir(), 'state.json'), 'utf8')
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  if (text === null) return null;
  const state = stateSchema.parse(JSON.parse(text));
  if (!state.releaseKeys.some((key) => key.id === state.activeReleaseKeyId)) {
    throw new Error('The signing key state names no active release key.');
  }
  return state;
}

/** The key set, or null before the first native deployment went live. */
export function readSigningKeys(): Promise<SigningKeyState | null> {
  return readState();
}

let creating: Promise<SigningKeyState> | undefined;

/** The key set, created now if this instance has none yet. */
export async function ensureSigningKeys(): Promise<SigningKeyState> {
  const existing = await readState();
  if (existing) return existing;
  creating ??= (async () => {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${SIGNING_KEYS_LOCK_NS}, 0)`,
        );
        const created = await readState();
        if (created) return created;
        const dir = signingKeysDir();
        await fs.mkdir(path.dirname(dir), { recursive: true });
        // The whole set is generated beside its place and moved there in
        // one rename, so no reader ever sees half of a set, and a set that
        // exists is never replaced.
        const staging = `${dir}.new-${randomUUID()}`;
        try {
          await runNshpkg([
            'keygen',
            '--out',
            staging,
            '--apps',
            NATIVE_APP_ID_PATTERN,
            '--days',
            String(RELEASE_KEY_DAYS),
          ]);
          await fs
            .rename(staging, dir)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') {
                throw error;
              }
            });
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
        }
        const state = await readState();
        if (!state) {
          throw new Error(
            `${dir} exists without a complete key set; it was left as it is.`,
          );
        }
        console.log(
          `[apps] created the package signing keys (root ${state.rootKeyId}, ` +
            `release ${state.activeReleaseKeyId})`,
        );
        return state;
      });
    } finally {
      creating = undefined;
    }
  })();
  return creating;
}

/** Paths of the active release key's files, for `hatch-nshpkg pack`. */
export function activeReleaseKeyFiles(state: SigningKeyState): {
  id: string;
  secret: string;
  certificate: string;
  root: string;
} {
  const dir = signingKeysDir();
  const id = state.activeReleaseKeyId;
  return {
    id,
    secret: path.join(dir, 'release', `${id}.secret`),
    certificate: path.join(dir, 'release', `${id}.cert`),
    root: path.join(dir, 'root.pub'),
  };
}

/** A signed JSON blob of `nsh-package`: a certificate or a revocation list. */
const signedSchema = z.object({
  body: z.string(),
  signer: z.string(),
  signature: z.string(),
});

function signedBody(text: string): unknown {
  const signed = signedSchema.parse(JSON.parse(text));
  return JSON.parse(Buffer.from(signed.body, 'base64').toString('utf8'));
}

const certificateBodySchema = z.object({
  key: z.string(),
  notBefore: z.number(),
  notAfter: z.number(),
  apps: z.array(z.string()),
});

const revocationsBodySchema = z.object({
  sequence: z.number(),
  issuedAt: z.number(),
  keys: z.array(z.string()),
  packages: z.array(z.string()),
});

export type RuntimeTrust = {
  /** False until the first native deployment went live. */
  initialized: boolean;
  appIdPattern: string;
  roots: { keyId: string; publicKey: string }[];
  releaseKeys: {
    keyId: string;
    publicKey: string;
    /** The root's certificate, as `nsh-package` writes it (JSON). */
    certificate: string;
    apps: string[];
    notBefore: Date;
    notAfter: Date;
    active: boolean;
    revoked: boolean;
  }[];
  revocations: {
    sequence: number;
    issuedAt: Date;
    keyIds: string[];
    packageSha256s: string[];
    /** The signed list, as `nsh-package` writes it (JSON). */
    signed: string;
  } | null;
};

const seconds = (value: number) => new Date(value * 1000);

/**
 * What a native shell needs to verify packages: public keys, certificates
 * and the revocation list. Reads only public files of the key set.
 */
export async function runtimeTrust(): Promise<RuntimeTrust> {
  const state = await readState();
  if (!state) {
    return {
      initialized: false,
      appIdPattern: NATIVE_APP_ID_PATTERN,
      roots: [],
      releaseKeys: [],
      revocations: null,
    };
  }
  const dir = signingKeysDir();
  const read = (file: string) =>
    fs.readFile(path.join(dir, file), 'utf8').then((text) => text.trim());
  const signedList = await read('revocations.json');
  const revocations = revocationsBodySchema.parse(signedBody(signedList));
  const revoked = new Set(revocations.keys);
  const releaseKeys = await Promise.all(
    state.releaseKeys.map(async (key) => {
      const certificate = await read(`release/${key.id}.cert`);
      const body = certificateBodySchema.parse(signedBody(certificate));
      return {
        keyId: key.id,
        publicKey: await read(`release/${key.id}.pub`),
        certificate,
        apps: body.apps,
        notBefore: seconds(body.notBefore),
        notAfter: seconds(body.notAfter),
        active: key.id === state.activeReleaseKeyId,
        revoked: revoked.has(key.id),
      };
    }),
  );
  return {
    initialized: true,
    appIdPattern: NATIVE_APP_ID_PATTERN,
    roots: [{ keyId: state.rootKeyId, publicKey: await read('root.pub') }],
    releaseKeys,
    revocations: {
      sequence: revocations.sequence,
      issuedAt: seconds(revocations.issuedAt),
      keyIds: revocations.keys,
      packageSha256s: revocations.packages,
      signed: signedList,
    },
  };
}
