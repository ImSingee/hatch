/**
 * Server-only: typed access to global platform settings stored in the
 * `platform_config` KV table.
 *
 * The table's `value` column is free-form `jsonb`, so adding a new setting
 * never needs a migration. But "generic storage" must not become "arbitrary
 * state": every key that may be read or written is declared in the registry
 * below with a Zod schema and a default. Callers reference keys through this
 * module only — nothing else touches `platform_config` — so the store stays
 * strongly typed and a corrupt/legacy row can never leak a bad value into the
 * app (it falls back to a declared per-key value instead).
 *
 * NOTE: imports here stay relative (`../db`), not `~/db`. This module is
 * reachable from `src/auth/server.ts`, which the Better Auth CLI loads
 * directly and cannot resolve the `~` path alias for.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { tailscaleConfigSchema, type TailscaleConfig } from '../tailscale';
import { db, schema } from '../db';
import type { TX } from '../db/db';
import type { JsonValue } from '../db/schema';

/** Model catalog refresh settings (`~server/model-catalog/refresh`). */
const modelCatalogConfigSchema = z.object({
  autoUpdate: z.boolean().catch(true),
  /** https mirror of aidy-models' models.json; null uses the default. */
  sourceUrl: z
    .string()
    .max(500)
    .regex(/^https:\/\/\S+$/)
    .nullable()
    .catch(null),
});
export type ModelCatalogConfig = z.infer<typeof modelCatalogConfigSchema>;

/** Outcome of the last catalog check, for the settings page. */
const modelCatalogStatusSchema = z.object({
  lastCheckedAt: z.iso.datetime({ offset: true }).nullable().catch(null),
  lastUpdatedAt: z.iso.datetime({ offset: true }).nullable().catch(null),
  lastError: z.string().max(500).nullable().catch(null),
  /** ETag of the last download, for the source it came from. */
  etag: z.string().max(300).nullable().catch(null),
  etagSourceUrl: z.string().max(500).nullable().catch(null),
});
export type ModelCatalogStatus = z.infer<typeof modelCatalogStatusSchema>;

type ConfigEntry<T> = {
  schema: z.ZodType<T>;
  /** Value used when no row exists (fresh install / key never written). */
  fallback: T;
  /**
   * Value used when a row exists but fails validation. Defaults to
   * `fallback`; set it separately when the two states shouldn't behave the
   * same — e.g. a security toggle that must default open on a fresh install
   * but fail closed if its stored value is corrupted.
   */
  invalidFallback?: T;
};

/**
 * The complete set of platform settings. Add a new key here (with its schema
 * and default) to introduce a setting — no schema migration required.
 */
const REGISTRY = {
  'network.tailscale': {
    schema: tailscaleConfigSchema,
    fallback: { enabled: false, hostname: 'hatch' },
    invalidFallback: { enabled: false, hostname: 'hatch' },
  } satisfies ConfigEntry<TailscaleConfig>,
  /**
   * Whether self-service sign-up is open. When false, only existing users can
   * sign in; the sign-up flow is rejected server-side (see the Better Auth
   * create hook) and hidden on the login page. Defaults to open so a fresh
   * deploy can bootstrap its first (owner) account — but a corrupted stored
   * value fails closed: the row only exists because someone set the toggle,
   * and silently reopening sign-up is the worse failure.
   */
  'auth.allowSignup': {
    schema: z.boolean(),
    fallback: true,
    invalidFallback: false,
  } satisfies ConfigEntry<boolean>,
  'models.catalog': {
    schema: modelCatalogConfigSchema,
    fallback: { autoUpdate: true, sourceUrl: null },
  } satisfies ConfigEntry<ModelCatalogConfig>,
  'models.catalogStatus': {
    schema: modelCatalogStatusSchema,
    fallback: {
      lastCheckedAt: null,
      lastUpdatedAt: null,
      lastError: null,
      etag: null,
      etagSourceUrl: null,
    },
  } satisfies ConfigEntry<ModelCatalogStatus>,
} as const;

export type PlatformConfigKey = keyof typeof REGISTRY;
export type PlatformConfigValue<K extends PlatformConfigKey> = z.infer<
  (typeof REGISTRY)[K]['schema']
>;

/**
 * Read a platform setting. A missing row yields the key's `fallback`; a row
 * whose stored value no longer matches the schema (e.g. left over from an
 * older format) yields its `invalidFallback` (or `fallback` when not
 * declared). Never throws.
 */
export async function getPlatformConfig<K extends PlatformConfigKey>(
  key: K,
): Promise<PlatformConfigValue<K>> {
  const row = await db.query.platformConfig.findFirst({
    where: { key },
  });
  return readStored(key, row);
}

/** A stored row as its typed value, with the key's fallbacks applied. */
function readStored<K extends PlatformConfigKey>(
  key: K,
  row: { value: unknown } | undefined,
): PlatformConfigValue<K> {
  const entry: ConfigEntry<unknown> = REGISTRY[key];
  if (!row) return entry.fallback as PlatformConfigValue<K>;

  const parsed = entry.schema.safeParse(row.value);
  if (!parsed.success) {
    console.warn(
      `[platform-config] "${key}" has an invalid stored value; ` +
        'using its fallback.',
      parsed.error.issues,
    );
    return (entry.invalidFallback ?? entry.fallback) as PlatformConfigValue<K>;
  }
  return parsed.data as PlatformConfigValue<K>;
}

// Advisory-lock namespace for the (int, int) form of pg_advisory_xact_lock.
// Existing namespaces elsewhere: 1 (App deploys), 2 (retired), 3
// (apps/kv.ts), 4 (pins.ts), 5 (dashboard-service.ts), 6 (apps/provision.ts),
// 8 (apps/tasks/service.ts), 9 (model-catalog/refresh.ts).
const PLATFORM_CONFIG_LOCK_NS = 7;

/**
 * Change part of a setting. `change` receives the current value (fallbacks
 * applied) and returns the whole new one. The read and the write hold a
 * per-key lock, so two partial changes made at once never undo each other.
 */
export async function updatePlatformConfig<K extends PlatformConfigKey>(
  key: K,
  change: (current: PlatformConfigValue<K>) => PlatformConfigValue<K>,
): Promise<PlatformConfigValue<K>> {
  return withPlatformConfigLock(key, (current, tx) =>
    writeLockedPlatformConfig(tx, key, change(current)),
  );
}

/**
 * Run `work` in one transaction that holds the key's lock, with the value
 * stored under it. Changes that check other tables against the setting (a
 * theme being deleted is not the active one) run their checks and writes
 * here, so a change to the setting cannot slip in between.
 */
export async function withPlatformConfigLock<K extends PlatformConfigKey, T>(
  key: K,
  work: (current: PlatformConfigValue<K>, tx: TX) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // A lock on the key, not on its row: the first write has no row to lock.
    await tx.execute(
      sql`select pg_advisory_xact_lock(${PLATFORM_CONFIG_LOCK_NS}, hashtext(${key}))`,
    );
    const row = await tx.query.platformConfig.findFirst({ where: { key } });
    return work(readStored(key, row), tx);
  });
}

/** Write a setting inside `withPlatformConfigLock`, validated like any. */
export async function writeLockedPlatformConfig<K extends PlatformConfigKey>(
  tx: TX,
  key: K,
  value: PlatformConfigValue<K>,
): Promise<PlatformConfigValue<K>> {
  const validated = REGISTRY[key].schema.parse(value) as JsonValue;
  await tx
    .insert(schema.platformConfig)
    .values({ key, value: validated })
    .onConflictDoUpdate({
      target: schema.platformConfig.key,
      set: { value: validated, updatedAt: new Date() },
    });
  return validated as PlatformConfigValue<K>;
}

/**
 * Persist a platform setting. The value is validated against the key's schema
 * before it is written, so a typed call site is the only way to change it.
 */
export async function setPlatformConfig<K extends PlatformConfigKey>(
  key: K,
  value: PlatformConfigValue<K>,
): Promise<void> {
  const entry = REGISTRY[key];
  const validated = entry.schema.parse(value) as JsonValue;
  await db
    .insert(schema.platformConfig)
    .values({ key, value: validated })
    .onConflictDoUpdate({
      target: schema.platformConfig.key,
      set: { value: validated, updatedAt: new Date() },
    });
}
