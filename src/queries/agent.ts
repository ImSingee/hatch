import { queryOptions } from '@tanstack/react-query';
import { getAgentRunnerStatusFn } from '~server/agent-runner-status';
import {
  getAgentModelChoices,
  getModelCatalogStatus,
  listCatalogProviders,
  listProviders,
} from '~server/providers';
import {
  getSession,
  listSessions,
  type SessionDetail,
} from '~server/agent-sessions';

export const providersQueryOptions = queryOptions({
  queryKey: ['agent', 'providers'],
  queryFn: () => listProviders(),
});

/** Chat models the signed-in user can pick, with their default. */
export const agentModelChoicesQueryOptions = queryOptions({
  queryKey: ['agent', 'model-choices'],
  queryFn: () => getAgentModelChoices(),
});

/** Provider presets of the built-in model catalog. */
export const catalogProvidersQueryOptions = queryOptions({
  queryKey: ['agent', 'catalog', 'providers'],
  queryFn: () => listCatalogProviders(),
  staleTime: 5 * 60 * 1000,
});

export const catalogStatusQueryOptions = queryOptions({
  queryKey: ['agent', 'catalog', 'status'],
  queryFn: () => getModelCatalogStatus(),
});

export const agentRunnerStatusQueryOptions = queryOptions({
  queryKey: ['agent', 'runner-status'],
  queryFn: () => getAgentRunnerStatusFn(),
  // Runner connections live in platform memory and runs progress without any
  // client-side event to invalidate on, so poll while the page is open.
  // Paused when the tab is hidden (refetchIntervalInBackground defaults to
  // false).
  refetchInterval: 5000,
});

export const sessionsQueryOptions = queryOptions({
  queryKey: ['agent', 'sessions'],
  queryFn: () => listSessions({ data: {} }),
});

export type SessionSnapshot = SessionDetail & {
  /** Server clock minus browser clock, estimated when the snapshot arrived. */
  clockOffsetMs: number;
};

export function sessionQueryOptions(sessionId: string) {
  return queryOptions({
    queryKey: ['agent', 'session', sessionId],
    queryFn: async (): Promise<SessionSnapshot | null> => {
      const requestedAt = Date.now();
      const session = await getSession({ data: sessionId });
      if (!session) return null;
      // Server timestamps drive the live work timer; align them to this
      // browser's clock, assuming the server read happened mid-request.
      const midpoint = (requestedAt + Date.now()) / 2;
      return {
        ...session,
        clockOffsetMs: Date.parse(session.serverTime) - midpoint,
      };
    },
    // The platform starts runs on its own: a scheduled automatic retry, and
    // the run delivering waiting messages once the session is idle. Re-read
    // the session until the new run appears.
    refetchInterval: (query) => {
      const session = query.state.data;
      if (!session || session.activeRun) return false;
      const nextRetryAt = session.retry?.nextRetryAt;
      if (nextRetryAt) {
        const dueInMs =
          Date.parse(nextRetryAt) - (Date.now() + session.clockOffsetMs);
        return dueInMs > 0 ? dueInMs + 500 : AUTO_RETRY_POLL_MS;
      }
      const pending = session.pending;
      return pending && !pending.paused && pending.messages.length > 0
        ? DELIVERY_POLL_MS
        : false;
    },
  });
}

const AUTO_RETRY_POLL_MS = 1000;
/** How often an idle session with waiting messages is re-read. */
const DELIVERY_POLL_MS = 1500;
