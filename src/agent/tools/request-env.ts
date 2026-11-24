/** Human-in-the-loop tool for requesting environment values from the user. */
import { z } from 'zod';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { EnvVariableField } from '../events';
import { ENV_KEY_PATTERN, requireEnvKey } from '../env-keys';
import { text, tool } from './shared';

export type StoredEnvVariable =
  | { key: string; secret: true }
  | { key: string; secret: false; value: string };

export type EnvBridge = (
  reason: string,
  variables: EnvVariableField[],
  signal?: AbortSignal,
) => Promise<StoredEnvVariable[]>;

export function createRequestEnvTool(bridge: EnvBridge): AgentTool {
  return tool({
    name: 'request_env',
    label: 'Request environment values',
    description:
      'Request one or more environment values from the user. Mark whether ' +
      'each value should be secret by default; the user makes the final ' +
      'visibility choice. Secret values are stored without entering the model ' +
      'context, while non-secret values are returned after storage.',
    executionMode: 'sequential',
    parameters: z.strictObject({
      reason: z
        .string()
        .min(1)
        .max(2000)
        .describe('Why these environment values are needed.'),
      variables: z
        .array(
          z.strictObject({
            key: z
              .string()
              .max(64)
              .regex(new RegExp(ENV_KEY_PATTERN))
              .describe('Environment variable key, such as API_TOKEN.'),
            description: z
              .string()
              .min(1)
              .max(1000)
              .describe('Where the user can obtain this value.'),
            secret: z
              .boolean()
              .describe(
                'Whether the value should be kept private from the model by default.',
              ),
          }),
        )
        .min(1)
        .max(10),
    }),
    execute: async (_id, params, signal) => {
      const variables = params.variables.map((variable) => ({
        key: requireEnvKey(variable.key),
        description: variable.description,
        secret: variable.secret,
      }));
      if (
        new Set(variables.map((variable) => variable.key)).size !==
        variables.length
      ) {
        throw new Error('Environment keys must be unique.');
      }

      const bridgeResult = await bridge(params.reason, variables, signal);
      // Reconstruct the result at the final model boundary. Even if a buggy
      // bridge attaches an extra value to a secret entry, it cannot flow into
      // tool text, details, the transcript, or the next model request.
      const stored: StoredEnvVariable[] = bridgeResult.map((variable) =>
        variable.secret
          ? { key: variable.key, secret: true }
          : {
              key: variable.key,
              secret: false,
              value: variable.value,
            },
      );
      const lines = stored.map((variable) =>
        variable.secret
          ? `- ${variable.key}: stored (value hidden)`
          : `- ${variable.key}: ${variable.value}`,
      );
      return text(
        `Stored environment values in .env:\n${lines.join('\n')}\n` +
          'Use run_command with env_keys to inject only the keys needed.',
        { variables: stored, path: '.env' },
      );
    },
  });
}
