/**
 * Server-only: the dedicated Builders serving this platform.
 *
 * A Builder is configured when the platform has `HATCH_BUILDER_TOKEN`. It is
 * online while it keeps talking to the platform: a Builder with a free slot
 * is always waiting on a lease request (at most LEASE_WAIT_MS each), and one
 * whose slots are all busy renews each lease every HEARTBEAT_MS. Every such
 * request records it here, so the status holds across platform instances.
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, schema } from '~/db';
import { getPlatformEnv } from '~env';
import { HEARTBEAT_MS, LEASE_WAIT_MS } from '../../builder/protocol';

/**
 * A Builder not heard from for this long is offline: several missed lease
 * requests or heartbeats in a row, not one slow request.
 */
export const BUILDER_ONLINE_MS = 3 * Math.max(LEASE_WAIT_MS, HEARTBEAT_MS);

/** Builders not heard from for this long are no longer listed. */
const BUILDER_LISTED_MS = 24 * 60 * 60_000;

const DB_NOW = sql`clock_timestamp()`;

export function builderConfigured(): boolean {
  return getPlatformEnv().builderToken !== null;
}

/**
 * Record that a Builder asked for work or renewed a lease. A lease request
 * says how many builds it runs at once; a heartbeat does not change that.
 */
export async function recordBuilderSeen(
  id: string,
  concurrency?: number,
): Promise<void> {
  await db
    .insert(schema.appBuilders)
    .values({ id, concurrency: concurrency ?? 1, lastSeenAt: DB_NOW })
    .onConflictDoUpdate({
      target: schema.appBuilders.id,
      set: {
        lastSeenAt: DB_NOW,
        ...(concurrency === undefined ? {} : { concurrency }),
      },
    });
}

export type BuilderView = {
  id: string;
  concurrency: number;
  /** Builds it holds now. */
  running: number;
  lastSeenAt: string;
  online: boolean;
};

export type BuilderStatus = {
  /** The platform accepts Builder builds (`HATCH_BUILDER_TOKEN` is set). */
  configured: boolean;
  /** Builders heard from in the last day, most recently seen first. */
  builders: BuilderView[];
};

export async function builderStatus(): Promise<BuilderStatus> {
  const configured = builderConfigured();
  if (!configured) return { configured, builders: [] };
  const rows = await db
    .select({
      id: schema.appBuilders.id,
      concurrency: schema.appBuilders.concurrency,
      lastSeenAt: schema.appBuilders.lastSeenAt,
      online: sql<boolean>`${schema.appBuilders.lastSeenAt} > ${DB_NOW} - ${BUILDER_ONLINE_MS}::integer * interval '1 millisecond'`,
    })
    .from(schema.appBuilders)
    .where(
      gt(
        schema.appBuilders.lastSeenAt,
        sql`${DB_NOW} - ${BUILDER_LISTED_MS}::integer * interval '1 millisecond'`,
      ),
    )
    .orderBy(sql`${schema.appBuilders.lastSeenAt} desc`);
  const running = rows.length
    ? await db
        .select({
          builderId: schema.appBuilds.builderId,
          count: sql<number>`count(*)::integer`,
        })
        .from(schema.appBuilds)
        .where(
          and(
            eq(schema.appBuilds.status, 'building'),
            inArray(
              schema.appBuilds.builderId,
              rows.map((row) => row.id),
            ),
          ),
        )
        .groupBy(schema.appBuilds.builderId)
    : [];
  const runningBy = new Map(running.map((row) => [row.builderId, row.count]));
  return {
    configured,
    builders: rows.map((row) => ({
      id: row.id,
      concurrency: row.concurrency,
      running: runningBy.get(row.id) ?? 0,
      lastSeenAt: row.lastSeenAt.toISOString(),
      online: row.online,
    })),
  };
}

/** Whether any Builder is online now. */
export async function builderOnline(): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.appBuilders.id })
    .from(schema.appBuilders)
    .where(
      gt(
        schema.appBuilders.lastSeenAt,
        sql`${DB_NOW} - ${BUILDER_ONLINE_MS}::integer * interval '1 millisecond'`,
      ),
    )
    .limit(1);
  return Boolean(row);
}
