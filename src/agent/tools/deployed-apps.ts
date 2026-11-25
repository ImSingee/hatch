/**
 * Report the Apps this turn deployed so the chat can show them.
 *
 * Deploys run through the `hatch` CLI, whose output the chat does not parse.
 * The Agent names the deployed Apps here instead; the frontend reads the
 * arguments of a successful call and resolves them against the App list.
 */
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { text, tool } from './shared';

const REPORT_DEPLOYED_APPS_TOOL = 'report_deployed_apps';

const MAX_REPORTED_APPS = 20;

export function createDeployedAppsTool(): AgentTool {
  return tool({
    name: REPORT_DEPLOYED_APPS_TOOL,
    label: 'Show deployed apps',
    description:
      'Show the user the Apps you deployed in this turn. Call it once after ' +
      'your last successful `hatch app deploy` (for a new or an existing ' +
      'App), passing the id of every App deployed in this turn. It does not ' +
      'deploy or check anything itself.',
    executionMode: 'sequential',
    parameters: z.object({
      app_ids: z
        .array(z.string().min(1).max(191))
        .min(1)
        .max(MAX_REPORTED_APPS)
        .describe(
          'Ids of the Apps successfully deployed in this turn, as printed ' +
            'in the `id` field of `hatch app deploy --json`.',
        ),
    }),
    execute: async (_id, params) => {
      const requested: unknown[] = Array.isArray(params.app_ids)
        ? params.app_ids
        : [];
      const appIds = [
        ...new Set(
          requested.map((id) => (typeof id === 'string' ? id.trim() : '')),
        ),
      ];
      if (appIds.length === 0 || appIds.some((id) => id.length === 0)) {
        throw new Error('Pass at least one non-empty App id in app_ids.');
      }
      return text(
        `The chat now shows ${appIds.length === 1 ? 'this deployed App' : `these ${appIds.length} deployed Apps`}: ${appIds.join(', ')}.`,
        { appIds },
      );
    },
  });
}
