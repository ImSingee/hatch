/**
 * Server-only: the platform's runner-facing internal server.
 *
 * A dedicated `node:http` server (default port 3701, never published outside
 * the deployment network) carrying:
 *   - the runner WebSocket control channel (RUNNER_WS_PATH), and
 *   - the internal REST API the runner's PlatformClient calls.
 *
 * Runner REST/WS requests must present AGENT_RUNNER_TOKEN; the Builder API
 * (`/internal/api/builds/`) accepts only HATCH_BUILDER_TOKEN.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RUNNER_WS_PATH } from '~agent/protocol';
import { getPlatformEnv } from '~env';
import {
  claimSteerMessages,
  completeRunFromRunner,
  deliverPendingAfterRunnerReady,
  ingestRunnerEvent,
  reconcileRunnerRuns,
  renewRunnerLeases,
  steerPendingRunIds,
} from '~server/agent-runs';
import { reconcileRunnerWorkspaces } from '~server/agent-workspaces';
import { secretsMatch } from '~server/secrets';
import { handleInternalApiRequest, internalApiRoute } from './internal-api';
import { handleRunnerSocket, type RunnerHubHandlers } from './hub';

/** Control-plane persistence the Runner Hub drives from runner messages. */
export const runnerHubHandlers: RunnerHubHandlers = {
  reconcileRunnerRuns,
  reconcileRunnerWorkspaces,
  renewRunnerLeases,
  ingestRunnerEvent,
  completeRunFromRunner,
  claimSteerMessages,
  steerPendingRunIds,
  runnerReady: () => deliverPendingAfterRunnerReady(),
};

type InternalServerGlobal = typeof globalThis & {
  __hatchInternalServer__?: { server: http.Server; port: number };
};

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function createInternalHttpHandler(
  token: string,
  builderToken: string | null = null,
): http.RequestListener {
  // The Builder API takes only the Builder's token, and Runner routes only
  // the Runner's: neither service can act as the other.
  const authorized = (req: http.IncomingMessage): boolean => {
    const builds = internalApiRoute(req.url)?.resource === 'builds';
    return secretsMatch(
      bearerToken(req.headers.authorization),
      builds ? builderToken : token,
    );
  };

  return (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    void handleInternalApiRequest(req, res);
  };
}

export function startAgentInternalServer(): void {
  const g = globalThis as InternalServerGlobal;
  if (g.__hatchInternalServer__) return;

  const {
    agentRunnerToken: token,
    builderToken,
    agentInternalHost,
    agentInternalPort,
  } = getPlatformEnv();

  const authorized = (req: http.IncomingMessage): boolean =>
    secretsMatch(bearerToken(req.headers.authorization), token);

  const server = http.createServer(
    createInternalHttpHandler(token, builderToken),
  );

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== RUNNER_WS_PATH || !authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleRunnerSocket(ws, { handlers: runnerHubHandlers });
    });
  });

  server.on('error', (error) => {
    console.error('[agent-internal] server error:', error);
  });

  server.listen(agentInternalPort, agentInternalHost, () => {
    console.log(
      `[agent-internal] listening on ${agentInternalHost}:${agentInternalPort}`,
    );
  });
  g.__hatchInternalServer__ = { server, port: agentInternalPort };
}
