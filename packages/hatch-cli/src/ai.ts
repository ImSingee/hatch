/**
 * App AI settings: the model each declared AI role uses, the monthly budget,
 * and the record of the App's AI calls.
 */
import { parseArgs } from 'node:util';
import { configPath, resolveCredential } from './config';
import { type AppAiView, platformClient } from './client';
import { CliError, argumentsError } from './error';

const ACTIONS = ['show', 'set-model', 'budget', 'usage'] as const;
type Action = (typeof ACTIONS)[number];

export type AiCommand = {
  action: Action;
  id: string;
  role?: string;
  /** Model id or `<provider>/<model>`; null clears the pick. */
  model?: string | null;
  /** Monthly cap in US dollars; null removes it. */
  budgetUsd?: number | null;
  limit?: number;
  cursor?: string;
  json: boolean;
  timeoutMs: number;
  config?: string;
  profile?: string;
};

function invalid(message: string): CliError {
  return new CliError('invalid_arguments', message);
}

/** Validate arguments locally; nothing is sent until this succeeds. */
export function parseAiCommand(
  args: readonly string[],
  offset: number,
): AiCommand {
  const action = args[offset + 2] as Action | undefined;
  if (!action || !ACTIONS.includes(action))
    throw invalid(
      'Use hatch app ai show, set-model, budget or usage. See hatch help app ai.',
    );
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + 3)],
      options: {
        json: { type: 'boolean' },
        config: { type: 'string' },
        profile: { type: 'string' },
        workdir: { type: 'string' },
        timeout: { type: 'string' },
        role: { type: 'string' },
        model: { type: 'string' },
        clear: { type: 'boolean' },
        'monthly-usd': { type: 'string' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw argumentsError(error, `app ai ${action}`);
  }
  const v = parsed.values;
  if (parsed.positionals.length !== 1 || !parsed.positionals[0])
    throw invalid(`Supply exactly one App ID or slug to app ai ${action}.`);
  const only = (flag: keyof typeof v, allowed: Action[]) => {
    if (v[flag] !== undefined && !allowed.includes(action))
      throw invalid(
        `--${flag} applies only to app ai ${allowed.join(' and app ai ')}.`,
      );
  };
  only('role', ['set-model']);
  only('model', ['set-model']);
  only('clear', ['set-model', 'budget']);
  only('monthly-usd', ['budget']);
  only('limit', ['usage']);
  only('cursor', ['usage']);

  let role: string | undefined;
  let model: string | null | undefined;
  if (action === 'set-model') {
    if (!v.role) throw invalid('app ai set-model needs --role <name>.');
    if (v.role.length > 64) throw invalid('--role is at most 64 characters.');
    role = v.role;
    if (v.model !== undefined && v.clear)
      throw invalid('Supply either --model or --clear, not both.');
    if (v.model === undefined && !v.clear)
      throw invalid(
        'app ai set-model needs --model <id|provider/model> or --clear.',
      );
    if (v.model !== undefined && (!v.model.trim() || v.model.length > 400))
      throw invalid('--model must be a model id or <provider>/<model>.');
    model = v.clear ? null : (v.model as string).trim();
  }

  let budgetUsd: number | null | undefined;
  if (action === 'budget') {
    const raw = v['monthly-usd'];
    if (raw !== undefined && v.clear)
      throw invalid('Supply either --monthly-usd or --clear, not both.');
    if (raw === undefined && !v.clear)
      throw invalid('app ai budget needs --monthly-usd <amount> or --clear.');
    if (raw !== undefined) {
      const amount = Number(raw);
      if (
        !/^[0-9]+(\.[0-9]{1,6})?$/.test(raw) ||
        !Number.isFinite(amount) ||
        amount > 1_000_000
      )
        throw invalid(
          '--monthly-usd must be an amount in US dollars from 0 to 1000000.',
        );
      budgetUsd = amount;
    } else budgetUsd = null;
  }

  const limit = v.limit === undefined ? undefined : Number(v.limit);
  if (
    limit !== undefined &&
    (!/^[0-9]+$/.test(v.limit as string) || limit < 1 || limit > 200)
  )
    throw invalid('--limit must be an integer between 1 and 200.');
  if (v.cursor === '' || (v.cursor?.length ?? 0) > 64)
    throw invalid('--cursor must be the nextCursor of the previous page.');

  const seconds = v.timeout === undefined ? 60 : Number(v.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    v.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v.profile)
  )
    throw invalid('Invalid profile name.');
  if (v.config === '') throw invalid('--config must not be empty.');
  return {
    action,
    id: parsed.positionals[0],
    role,
    model,
    budgetUsd,
    limit,
    cursor: v.cursor,
    json: v.json === true,
    timeoutMs: Math.ceil(seconds * 1000),
    config: v.config,
    profile: v.profile,
  };
}

const usd = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;

/** Every identifier a follow-up `set-model` needs, one role per line. */
export function aiText(view: AppAiView): string {
  if (!view.available)
    return `${view.appId}  No AI roles (the live deployment declares none).`;
  const lines = [
    `${view.appId}  month since ${view.monthStart.slice(0, 10)}: ${usd(view.monthSpendUsd)}${view.monthUnpricedCalls ? ` (+${view.monthUnpricedCalls} unpriced calls)` : ''}  budget: ${view.budgetUsd === null ? 'none' : usd(view.budgetUsd)}`,
  ];
  for (const role of view.roles) {
    const model = role.model
      ? `${role.model.ref} (${role.model.id})${role.bound ? '' : ' default'}${role.unavailable ? ' UNAVAILABLE' : ''}`
      : 'no model configured';
    const warn = role.missingNeeds.length
      ? `  missing: ${role.missingNeeds.join(',')}`
      : '';
    lines.push(`  ${role.name}  ${role.kind}  ${model}${warn}`);
  }
  return lines.join('\n');
}

export async function runAi(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const command = parseAiCommand(args, offset);
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, command.config),
    command.profile,
  );
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(command.timeoutMs),
  ]);
  const { ai } = platformClient(credential, command.timeoutMs, deadline).apps;
  const write = (json: unknown, text: string) =>
    process.stdout.write(
      command.json ? `${JSON.stringify(json)}\n` : `${text}\n`,
    );

  if (command.action === 'show') {
    const view = await ai.show({ id: command.id });
    write(view, aiText(view));
    return;
  }
  if (command.action === 'set-model') {
    const view = await ai.setModel({
      id: command.id,
      role: command.role as string,
      ...(command.model ? { model: command.model } : {}),
    });
    write(view, aiText(view));
    return;
  }
  if (command.action === 'budget') {
    const view = await ai.setBudget({
      id: command.id,
      ...(command.budgetUsd === null || command.budgetUsd === undefined
        ? {}
        : { budgetUsd: command.budgetUsd }),
    });
    write(view, aiText(view));
    return;
  }
  const page = await ai.usage({
    id: command.id,
    limit: command.limit,
    cursor: command.cursor,
  });
  write(
    page,
    [
      `${page.appId}  month since ${page.monthStart.slice(0, 10)}`,
      ...page.monthTotals.map(
        (row) =>
          `  ${row.role}  ${row.providerName}/${row.modelId}  calls=${row.calls}  in=${row.inputTokens}  out=${row.outputTokens}${row.images ? `  images=${row.images}` : ''}  ${usd(row.costUsd)}${row.unpricedCalls ? ` (+${row.unpricedCalls} unpriced)` : ''}`,
      ),
      ...(page.calls.length
        ? page.calls.map(
            (call) =>
              `${call.id}  ${call.createdAt}  ${call.role}  ${call.providerName}/${call.modelId}  ${call.status}${call.errorCode ? `:${call.errorCode}` : ''}  in=${call.inputTokens}  out=${call.outputTokens}  ${call.costUsd === null ? 'unpriced' : usd(call.costUsd)}  ${call.durationMs}ms`,
          )
        : ['No calls.']),
      ...(page.nextCursor === null ? [] : [`next cursor: ${page.nextCursor}`]),
    ].join('\n'),
  );
}
