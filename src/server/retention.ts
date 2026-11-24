/**
 * Server-only: periodic pruning of unbounded history tables.
 *
 * Cron logs, cron run history, workflow runs, and agent run events all grow
 * with every trigger and would otherwise accumulate forever on a single-tenant
 * install. Each table keeps a generous window (diagnosis stays possible) and
 * everything older is deleted in one daily sweep.
 */
import { sql } from 'drizzle-orm';
import { sweepExpiredCandidates } from '~server/images/candidates';
import { db } from '~/db';
import {
  pruneOrphanedAgentAttachmentSessions,
  prunePendingAgentAttachments,
} from './agent-attachments';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back each history table is kept. */
const RETENTION_DAYS = {
  /** Structured trigger logs (`logs`): cron/webhook diagnostics. */
  logs: 30,
  /** Cron trigger history (`app_cron_runs`): the ops-panel run list. */
  cronRuns: 30,
  /** Workflow executions (+ steps via cascade): user-facing run history. */
  workflowRuns: 90,
  /** App task runs (+ steps via cascade): the Tasks run history. */
  taskRuns: 90,
  /**
   * Agent run replay events. Only needed while a client may still reconnect
   * to a stream; the durable transcript lives on the session row. Events of
   * runs still running/blocked are never touched.
   */
  agentRunEvents: 7,
  /** Notification history (+ deliveries via cascade). */
  notifications: 90,
} as const;

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** ISO cutoff timestamp `days` ago (bound as text, cast in SQL). */
function cutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** One pruning pass over every history table. Deletes are idempotent. */
export async function pruneHistory(): Promise<void> {
  await db.execute(
    sql`delete from logs
        where created_at < ${cutoff(RETENTION_DAYS.logs)}::timestamptz`,
  );
  await db.execute(
    sql`delete from app_cron_runs
        where created_at < ${cutoff(RETENTION_DAYS.cronRuns)}::timestamptz`,
  );
  // Steps cascade with their run. Never remove a run that hasn't terminated:
  // the executor may still be attached to it.
  await db.execute(
    sql`delete from workflow_runs
        where created_at < ${cutoff(RETENTION_DAYS.workflowRuns)}::timestamptz
          and status not in ('queued', 'running')`,
  );
  await db.execute(
    sql`delete from app_task_runs
        where created_at < ${cutoff(RETENTION_DAYS.taskRuns)}::timestamptz
          and status not in ('queued', 'running')`,
  );
  // Replay events are useless once no client can reconnect to the run; keep
  // the run row itself (diagnostics) and drop only its event backlog.
  await db.execute(
    sql`delete from agent_run_events e
        using agent_runs r
        where e.run_id = r.id
          and r.status not in ('running', 'blocked')
          and coalesce(r.completed_at, r.created_at)
              < ${cutoff(RETENTION_DAYS.agentRunEvents)}::timestamptz`,
  );
  // Never drop a notification that still has a delivery in flight, of the
  // notification itself or of its answer. Candidates are locked first (an
  // answer in progress holds its row and is skipped), and the delivery check
  // runs as a later statement, so it sees anything committed meanwhile; an
  // answer that locks a row after this deletes it finds it gone.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`create temporary table expired_notifications on commit drop as
          select id from notifications
          where created_at < ${cutoff(RETENTION_DAYS.notifications)}::timestamptz
          for update skip locked`,
    );
    await tx.execute(
      sql`delete from notifications n
          using expired_notifications e
          where n.id = e.id
            and not exists (
              select 1 from notification_deliveries d
              where d.notification_id = n.id
                and d.status in ('pending', 'in_progress')
            )
            and not exists (
              select 1 from notification_response_deliveries r
              where r.notification_id = n.id
                and r.status in ('pending', 'in_progress')
            )`,
    );
  });
  await prunePendingAgentAttachments();
  await pruneOrphanedAgentAttachmentSessions();
}

type RetentionGlobal = typeof globalThis & {
  __hatchRetention__?: boolean;
};

/**
 * Start the daily retention sweep once per process (idempotent). Runs a first
 * pass immediately so a long-lived install that just upgraded is trimmed at
 * boot, not half a day later.
 */
export function ensureRetentionSweep(): void {
  const g = globalThis as RetentionGlobal;
  if (g.__hatchRetention__) return;
  g.__hatchRetention__ = true;
  const sweep = () => {
    void pruneHistory().catch((error) => {
      console.error('[retention] prune failed:', error);
    });
    // Generated image candidates expire after a day whether or not anyone
    // generates again.
    void sweepExpiredCandidates().catch((error) => {
      console.error('[retention] image candidate sweep failed:', error);
    });
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}
