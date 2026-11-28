/**
 * Server-only: per-App AI call records and the per-App limit on calls in
 * flight.
 */
import { db, schema } from '~/db';
import type { AppAiCallKind, AppAiCallStatus } from '~/db/schema';
import { AiCallError, MAX_AI_CONCURRENT_CALLS } from './contract';

/** Start of the current calendar month in UTC, the usage summary period. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const inFlight = new Map<string, number>();

/**
 * Hold one of the App's call slots until the returned release runs. Bounds a
 * runaway task loop instead of letting it saturate the provider. Counted per
 * platform process.
 */
export function acquireCallSlot(appId: string): () => void {
  const current = inFlight.get(appId) ?? 0;
  if (current >= MAX_AI_CONCURRENT_CALLS)
    throw new AiCallError(
      'ai_busy',
      `This App already has ${MAX_AI_CONCURRENT_CALLS} AI calls in flight; wait for one to finish.`,
    );
  inFlight.set(appId, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(appId) ?? 1) - 1;
    if (left <= 0) inFlight.delete(appId);
    else inFlight.set(appId, left);
  };
}

export type UsageRecord = {
  appId: string;
  deploymentId: string | null;
  role: string;
  kind: AppAiCallKind;
  providerName: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  images?: number;
  status: AppAiCallStatus;
  errorCode?: string | null;
  durationMs: number;
};

export async function recordUsage(record: UsageRecord): Promise<void> {
  await db.insert(schema.appAiUsage).values({
    appId: record.appId,
    deploymentId: record.deploymentId,
    role: record.role,
    kind: record.kind,
    providerName: record.providerName,
    modelId: record.modelId,
    inputTokens: Math.round(record.inputTokens ?? 0),
    outputTokens: Math.round(record.outputTokens ?? 0),
    cacheReadTokens: Math.round(record.cacheReadTokens ?? 0),
    cacheWriteTokens: Math.round(record.cacheWriteTokens ?? 0),
    images: record.images ?? 0,
    status: record.status,
    errorCode: record.errorCode ?? null,
    durationMs: Math.round(record.durationMs),
  });
}
