import { queryOptions } from '@tanstack/react-query';
import { notFound } from '@tanstack/react-router';
import {
  getAppBySlug,
  getAppDocFn,
  getAppOps,
  getDeploymentBuildLog,
  getNormalizedManifest,
  inspectAppDataTablesFn,
  listAppBackendsFn,
  listAppKvFn,
  listApps,
  listCronRunsFn,
  listDeployments,
  getAppDeploymentLogFn,
  getBuilderOverviewFn,
  listAppDeploymentRequestsFn,
} from '~server/apps';

export const appsQueryOptions = queryOptions({
  queryKey: ['apps'],
  queryFn: () => listApps(),
});

/**
 * The App view's detail snapshot. The route loader (navigation) and the
 * explicit reload fetch it with `staleTime: 0`, and nothing refetches it in
 * the background. A running App keeps the deployment revision it loaded as
 * its own "has update" baseline (`AppSession.revision`), so a navigation that
 * re-reads this snapshot never hides a pending update. The key stays outside
 * the `['apps']` prefix so list invalidations elsewhere leave it alone.
 */
export const appViewQueryOptions = (slug: string) =>
  queryOptions({
    queryKey: ['app-view', slug],
    queryFn: async () => {
      const app = await getAppBySlug({ data: slug });
      if (!app) throw notFound();
      return app;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

export const appBackendsQueryOptions = queryOptions({
  queryKey: ['apps', 'backends'],
  queryFn: () => listAppBackendsFn(),
  // Backend state lives in platform memory and changes without client events
  // (serverless boots on request, keep-alive restarts after a crash), so poll
  // fast while the page is open. Paused when the tab is hidden
  // (refetchIntervalInBackground defaults to false).
  refetchInterval: 2000,
});

export const deploymentsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'deployments'],
    queryFn: () => listDeployments({ data: id }),
  });

export const deploymentBuildLogQueryOptions = (
  appId: string,
  deploymentId: string,
) =>
  queryOptions({
    queryKey: ['apps', appId, 'deployments', deploymentId, 'build-log'],
    queryFn: () => getDeploymentBuildLog({ data: { id: appId, deploymentId } }),
    // A deployment's build log is immutable, so never refetch once loaded.
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * Recent deployment requests. Poll quickly while one is still building or
 * releasing, so the page follows it; slowly otherwise to notice new ones.
 */
/** Builders and the queue across Apps; refreshed while anything is queued. */
export const builderOverviewQueryOptions = queryOptions({
  queryKey: ['builder', 'overview'],
  queryFn: () => getBuilderOverviewFn(),
  refetchInterval: (query) =>
    query.state.data && query.state.data.queue.length > 0 ? 3000 : 10000,
});

export const deploymentRequestsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'deployment-requests'],
    queryFn: () => listAppDeploymentRequestsFn({ data: id }),
    refetchInterval: (query) =>
      query.state.data?.deployments.some((item) => !item.finished)
        ? 2000
        : 15000,
  });

type DeploymentRequestLogPage = Awaited<
  ReturnType<typeof getAppDeploymentLogFn>
>;

export type DeploymentRequestLog = {
  deployment: DeploymentRequestLogPage['deployment'];
  lines: DeploymentRequestLogPage['lines'];
  /** Every line the deployment will write has been read. */
  complete: boolean;
};

/**
 * A deployment's whole log. Each fetch continues after the last cached line
 * and reads pages until the server has no more, so long logs arrive in full.
 * Polls while the deployment runs, and once more after it finishes: the
 * platform writes some closing lines just after the final status.
 */
export const deploymentRequestLogQueryOptions = (
  appId: string,
  deploymentId: string,
) =>
  queryOptions({
    queryKey: ['apps', appId, 'deployment-requests', deploymentId, 'log'],
    queryFn: async ({ client, queryKey, signal }) => {
      const cached = client.getQueryData<DeploymentRequestLog>(queryKey);
      const lines = [...(cached?.lines ?? [])];
      let page: DeploymentRequestLogPage;
      do {
        page = await getAppDeploymentLogFn({
          data: {
            id: appId,
            deploymentId,
            afterSeq: lines.at(-1)?.seq ?? 0,
          },
          signal,
        });
        lines.push(...page.lines);
      } while (page.more && page.lines.length > 0);
      return {
        deployment: page.deployment,
        lines,
        complete: Boolean(cached?.deployment.finished),
      } satisfies DeploymentRequestLog;
    },
    refetchInterval: (query) => (query.state.data?.complete ? false : 1500),
    staleTime: (query) =>
      query.state.data?.complete ? Number.POSITIVE_INFINITY : 0,
  });

export const appOpsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'ops'],
    queryFn: () => getAppOps({ data: id }),
  });

export const cronRunsQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'cron-runs'],
    queryFn: () => listCronRunsFn({ data: id }),
    // Scheduled fires are written by the background scheduler with no client
    // event to invalidate against, so poll while the panel is open to surface
    // them live. React Query pauses this when the tab is hidden
    // (refetchIntervalInBackground defaults to false), so it stays cheap;
    // manual "Run now" still invalidates for an instant update.
    refetchInterval: 15_000,
  });

export const normalizedManifestQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'manifest'],
    queryFn: () => getNormalizedManifest({ data: id }),
  });

/** A doc body that no longer matches the manifest it was requested for. */
export class StaleAppDocError extends Error {
  constructor() {
    super('This doc changed with a new deployment. Reloading the docs.');
    this.name = 'StaleAppDocError';
  }
}

/**
 * Keyed by the body hash so a redeploy never shows a cached older body. The
 * server reads the deployment current at request time, so a body whose hash
 * differs belongs to a newer deployment: it is never cached under this key;
 * the manifest is refetched instead, which yields the new key.
 */
export const appDocQueryOptions = (id: string, docId: string, sha256: string) =>
  queryOptions({
    queryKey: ['apps', id, 'docs', docId, sha256],
    queryFn: async ({ client }) => {
      const result = await getAppDocFn({ data: { id, docId } });
      if (result.doc.sha256 !== sha256) {
        await client.invalidateQueries({
          queryKey: normalizedManifestQueryOptions(id).queryKey,
        });
        throw new StaleAppDocError();
      }
      return result;
    },
    retry: (count, error) => !(error instanceof StaleAppDocError) && count < 3,
  });

export const appKvQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'kv'],
    queryFn: () => listAppKvFn({ data: id }),
  });

export const appDataTablesQueryOptions = (id: string) =>
  queryOptions({
    queryKey: ['apps', id, 'data-tables'],
    queryFn: () => inspectAppDataTablesFn({ data: id }),
  });
