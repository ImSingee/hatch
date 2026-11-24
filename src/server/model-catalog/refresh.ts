/**
 * Server-only: keep the model catalog current without a Hatch release.
 *
 * Every few hours the platform asks aidy-models (or a configured mirror)
 * whether `models.json` changed. A new file is built with the same code as
 * the bundled snapshot, checked for plausibility and stored; the newest
 * valid data — downloaded or bundled — is what the platform uses. Any
 * failure keeps the catalog in use and is recorded for the settings page.
 */
import { desc, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import type { JsonValue } from '~/db/schema';
import { AppError } from '~server/errors';
import {
  getPlatformConfig,
  updatePlatformConfig,
  type ModelCatalogConfig,
} from '~server/platform-config';
import {
  AIDY_MODELS_REPOSITORY,
  assertPlausibleUpdate,
  buildCatalog,
  CURATION_FINGERPRINT,
} from './build';
import {
  activeCatalog,
  bundledCatalog,
  newestCatalog,
  setActiveCatalog,
} from './index';
import { catalogSchema, type Catalog } from './types';

export const DEFAULT_CATALOG_SOURCE_URL = `https://raw.githubusercontent.com/${AIDY_MODELS_REPOSITORY}/refs/heads/master/models.json`;

const FIRST_CHECK_DELAY_MS = 3 * 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Picks up a catalog another platform process stored. */
const RELOAD_INTERVAL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const KEEP_SNAPSHOTS = 3;
// Advisory-lock namespace (see platform-config.ts for the others).
const CATALOG_REFRESH_LOCK_NS = 9;

export type CatalogStatusView = {
  source: 'bundled' | 'downloaded';
  generatedAt: string;
  providerCount: number;
  modelCount: number;
  autoUpdate: boolean;
  sourceUrl: string | null;
  effectiveSourceUrl: string;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
};

export type RefreshOutcome = 'updated' | 'unchanged' | 'failed';

function countModels(catalog: Catalog): number {
  return Object.values(catalog.models).reduce(
    (total, models) => total + models.length,
    0,
  );
}

/** The newest stored catalog that still validates, if any. */
async function latestStoredCatalog(): Promise<Catalog | null> {
  const rows = await db
    .select({
      id: schema.modelCatalogSnapshots.id,
      data: schema.modelCatalogSnapshots.data,
    })
    .from(schema.modelCatalogSnapshots)
    .orderBy(desc(schema.modelCatalogSnapshots.generatedAt))
    .limit(KEEP_SNAPSHOTS);
  for (const row of rows) {
    const parsed = catalogSchema.safeParse(row.data);
    // Built by another Hatch version: the next check rebuilds it.
    if (parsed.success && parsed.data.source.curation === CURATION_FINGERPRINT)
      return parsed.data;
    if (parsed.success) continue;
    console.warn(
      `[model-catalog] ignoring stored catalog ${row.id}: it no longer validates`,
    );
  }
  return null;
}

/** Use the newest valid catalog: downloaded or bundled. */
export async function loadModelCatalog(): Promise<Catalog> {
  const catalog = newestCatalog(await latestStoredCatalog());
  setActiveCatalog(catalog);
  return catalog;
}

export async function getCatalogStatus(): Promise<CatalogStatusView> {
  const [config, status] = await Promise.all([
    getPlatformConfig('models.catalog'),
    getPlatformConfig('models.catalogStatus'),
  ]);
  const catalog = activeCatalog();
  return {
    source: catalog === bundledCatalog() ? 'bundled' : 'downloaded',
    generatedAt: catalog.source.generatedAt,
    providerCount: catalog.providers.length,
    modelCount: countModels(catalog),
    autoUpdate: config.autoUpdate,
    sourceUrl: config.sourceUrl,
    effectiveSourceUrl: config.sourceUrl ?? DEFAULT_CATALOG_SOURCE_URL,
    lastCheckedAt: status.lastCheckedAt,
    lastUpdatedAt: status.lastUpdatedAt,
    lastError: status.lastError,
  };
}

async function download(
  url: string,
  etag: string | null,
): Promise<{ notModified: true } | { body: unknown; etag: string | null }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // A mirror must serve the file itself, not send us elsewhere.
      redirect: 'error',
    });
  } catch {
    throw new AppError('The catalog source could not be reached.', 400);
  }
  if (response.status === 304) return { notModified: true };
  if (!response.ok)
    throw new AppError(`The catalog source answered ${response.status}.`, 400);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_DOWNLOAD_BYTES)
    throw new AppError('The catalog file is too large.', 400);
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('The catalog source sent no data.', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('The catalog file is too large.', 400);
    }
    chunks.push(value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('The catalog file is not valid JSON.', 400);
  }
  return { body, etag: response.headers.get('etag') };
}

async function recordStatus(
  change: Partial<{
    lastError: string | null;
    lastUpdatedAt: string;
    etag: string | null;
    etagSourceUrl: string | null;
  }>,
): Promise<void> {
  await updatePlatformConfig('models.catalogStatus', (current) => ({
    ...current,
    ...change,
    lastCheckedAt: new Date().toISOString(),
  }));
}

/**
 * Check the source once. Concurrent checks (another request or another
 * platform process) wait for the first and report `unchanged`.
 */
export async function refreshModelCatalog(): Promise<{
  outcome: RefreshOutcome;
  status: CatalogStatusView;
}> {
  const [config, previous] = await Promise.all([
    getPlatformConfig('models.catalog'),
    getPlatformConfig('models.catalogStatus'),
  ]);
  const url = config.sourceUrl ?? DEFAULT_CATALOG_SOURCE_URL;
  let outcome: RefreshOutcome;
  // Status is written after the transaction: it must not wait on (or hold)
  // a second connection while the lock is held.
  let statusChange: Parameters<typeof recordStatus>[0] | null = null;
  try {
    outcome = await db.transaction(async (tx) => {
      // The query builder reads rows the same way on every driver.
      const [{ locked }] = await tx
        .select({
          locked: sql<boolean>`pg_try_advisory_xact_lock(${CATALOG_REFRESH_LOCK_NS}, 0)`,
        })
        .from(sql`(values (1)) as one (x)`);
      if (!locked) return 'unchanged';
      // The ETag only says the upstream file is unchanged; a catalog built
      // with another curation must still be rebuilt from it.
      const etagKey = `${url}#${CURATION_FINGERPRINT}`;
      const result = await download(
        url,
        previous.etagSourceUrl === etagKey ? previous.etag : null,
      );
      if ('notModified' in result) {
        statusChange = { lastError: null };
        return 'unchanged';
      }
      const { catalog, warnings } = buildCatalog(result.body);
      for (const warning of warnings)
        console.warn(`[model-catalog] ${warning}`);
      const current = activeCatalog();
      statusChange = {
        lastError: null,
        etag: result.etag,
        etagSourceUrl: etagKey,
      };
      if (
        catalog.source.generatedAt === current.source.generatedAt &&
        catalog.source.curation === current.source.curation
      )
        return 'unchanged';
      assertPlausibleUpdate(catalog, current);
      await tx.insert(schema.modelCatalogSnapshots).values({
        sourceUrl: url,
        generatedAt: new Date(catalog.source.generatedAt),
        data: catalog as unknown as JsonValue,
        providerCount: catalog.providers.length,
        modelCount: countModels(catalog),
      });
      const keep = await tx
        .select({ id: schema.modelCatalogSnapshots.id })
        .from(schema.modelCatalogSnapshots)
        .orderBy(desc(schema.modelCatalogSnapshots.generatedAt))
        .limit(KEEP_SNAPSHOTS);
      await tx.delete(schema.modelCatalogSnapshots).where(
        notInArray(
          schema.modelCatalogSnapshots.id,
          keep.map((row) => row.id),
        ),
      );
      statusChange = {
        ...statusChange,
        lastUpdatedAt: new Date().toISOString(),
      };
      return 'updated';
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The catalog check failed.';
    console.warn(`[model-catalog] refresh failed: ${message}`);
    statusChange = { lastError: message.slice(0, 500) };
    outcome = 'failed';
  }
  if (statusChange) await recordStatus(statusChange).catch(() => undefined);
  if (outcome === 'updated') await loadModelCatalog();
  return { outcome, status: await getCatalogStatus() };
}

export async function updateCatalogSettings(input: {
  autoUpdate?: boolean;
  /** null returns to the default source. */
  sourceUrl?: string | null;
}): Promise<CatalogStatusView> {
  if (input.sourceUrl) {
    let url: URL;
    try {
      url = new URL(input.sourceUrl);
    } catch {
      throw new AppError('The source URL must be an https URL.', 400);
    }
    if (url.protocol !== 'https:' || input.sourceUrl.length > 500)
      throw new AppError('The source URL must be an https URL.', 400);
  }
  await updatePlatformConfig(
    'models.catalog',
    (current): ModelCatalogConfig => ({
      autoUpdate: input.autoUpdate ?? current.autoUpdate,
      sourceUrl:
        input.sourceUrl === undefined ? current.sourceUrl : input.sourceUrl,
    }),
  );
  return getCatalogStatus();
}

type RefreshGlobal = typeof globalThis & { __hatchModelCatalog__?: boolean };

/**
 * Load the catalog in use and keep it current, once per process. Checks wait
 * a few minutes after boot so a restart loop never hammers the source.
 */
export function ensureModelCatalogRefresh(): void {
  const g = globalThis as RefreshGlobal;
  if (g.__hatchModelCatalog__) return;
  g.__hatchModelCatalog__ = true;
  const reload = () =>
    void loadModelCatalog().catch((error) => {
      console.error(
        '[model-catalog] could not load the stored catalog:',
        error,
      );
    });
  const check = async () => {
    try {
      const config = await getPlatformConfig('models.catalog');
      if (config.autoUpdate) await refreshModelCatalog();
    } catch (error) {
      console.error('[model-catalog] scheduled check failed:', error);
    }
  };
  reload();
  const timers = [
    setTimeout(() => void check(), FIRST_CHECK_DELAY_MS),
    setInterval(() => void check(), CHECK_INTERVAL_MS),
    setInterval(reload, RELOAD_INTERVAL_MS),
  ];
  for (const timer of timers)
    if (typeof timer.unref === 'function') timer.unref();
}
