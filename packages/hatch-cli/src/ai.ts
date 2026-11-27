/**
 * App AI settings: the default chat and image models for Apps, the model
 * each declared AI role of an App uses, and the record of an App's AI calls.
 */
import { parseArgs } from 'node:util';
import { configPath, resolveCredential } from './config';
import {
  type AppAiDefaultsView,
  type AppAiView,
  platformClient,
} from './client';
import { CliError, argumentsError } from './error';

const ACTIONS = ['show', 'set-model', 'usage', 'defaults'] as const;
type Action = (typeof ACTIONS)[number];

/** A model to set, or null to clear; undefined leaves it unchanged. */
type ModelChange = string | null | undefined;

export type AiCommand = {
  action: Action;
  /** App id or slug; absent for `defaults`. */
  id?: string;
  role?: string;
  /** Model id or `<provider>/<model>`; null clears the pick. */
  model?: string | null;
  chatModel?: ModelChange;
  imageModel?: ModelChange;
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

function modelRef(flag: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 400)
    throw invalid(`--${flag} must be a model id or <provider>/<model>.`);
  return trimmed;
}

/** One model flag pair: `--<name> <ref>` sets it, `--clear-<name>` clears it. */
function modelChange(
  name: string,
  value: string | undefined,
  clear: boolean | undefined,
): ModelChange {
  if (value !== undefined && clear)
    throw invalid(`Supply either --${name} or --clear-${name}, not both.`);
  if (clear) return null;
  return value === undefined ? undefined : modelRef(name, value);
}

/** Validate arguments locally; nothing is sent until this succeeds. */
export function parseAiCommand(
  args: readonly string[],
  offset: number,
): AiCommand {
  const action = args[offset + 2] as Action | undefined;
  if (!action || !ACTIONS.includes(action))
    throw invalid(
      'Use hatch app ai show, set-model, usage or defaults. See hatch help app ai.',
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
        'chat-model': { type: 'string' },
        'clear-chat-model': { type: 'boolean' },
        'image-model': { type: 'string' },
        'clear-image-model': { type: 'boolean' },
        limit: { type: 'string' },
        cursor: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    throw argumentsError(error, `app ai ${action}`);
  }
  const v = parsed.values;
  const positionals = parsed.positionals;
  if (action === 'defaults') {
    if (positionals.length)
      throw invalid(
        'app ai defaults takes no App: the defaults apply to every App.',
      );
  } else if (positionals.length !== 1 || !positionals[0])
    throw invalid(`Supply exactly one App ID or slug to app ai ${action}.`);
  const only = (flag: keyof typeof v, allowed: Action[]) => {
    if (v[flag] !== undefined && !allowed.includes(action))
      throw invalid(
        `--${flag} applies only to app ai ${allowed.join(' and app ai ')}.`,
      );
  };
  only('role', ['set-model']);
  only('model', ['set-model']);
  only('clear', ['set-model']);
  for (const flag of [
    'chat-model',
    'clear-chat-model',
    'image-model',
    'clear-image-model',
  ] as const)
    only(flag, ['defaults']);
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
    model = v.clear ? null : modelRef('model', v.model as string);
  }
  const chatModel = modelChange(
    'chat-model',
    v['chat-model'],
    v['clear-chat-model'],
  );
  const imageModel = modelChange(
    'image-model',
    v['image-model'],
    v['clear-image-model'],
  );

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
    id: positionals[0],
    role,
    model,
    chatModel,
    imageModel,
    limit,
    cursor: v.cursor,
    json: v.json === true,
    timeoutMs: Math.ceil(seconds * 1000),
    config: v.config,
    profile: v.profile,
  };
}

const modelText = (model: { ref: string; id: string } | null) =>
  model ? `${model.ref} (${model.id})` : 'no model configured';

/** Every identifier a follow-up `set-model` needs, one role per line. */
export function aiText(view: AppAiView): string {
  if (!view.available)
    return `${view.appId}  No AI roles (the live deployment declares none).`;
  const lines = [view.appId];
  for (const role of view.roles) {
    const source = role.bound
      ? 'picked'
      : role.defaultSource === 'setting'
        ? 'default for Apps'
        : 'first model';
    const warn = [
      ...(role.unavailable ? ['UNAVAILABLE'] : []),
      ...(role.missingNeeds.length
        ? [`missing: ${role.missingNeeds.join(',')}`]
        : []),
    ];
    lines.push(
      `  ${role.name}  ${role.kind}  ${modelText(role.model)}  ${source}${warn.length ? `  ${warn.join('  ')}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function defaultsText(view: AppAiDefaultsView): string {
  return (['chat', 'image'] as const)
    .map((kind) => {
      const entry = view[kind];
      const source =
        entry.source === 'setting' ? 'set' : 'not set, first model';
      return `${kind}  ${modelText(entry.model)}  ${source}${entry.unavailable ? '  UNAVAILABLE' : ''}`;
    })
    .join('\n');
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

  if (command.action === 'defaults') {
    const change =
      command.chatModel !== undefined || command.imageModel !== undefined;
    const view = change
      ? await ai.setDefaults({
          ...(command.chatModel ? { chatModel: command.chatModel } : {}),
          clearChatModel: command.chatModel === null,
          ...(command.imageModel ? { imageModel: command.imageModel } : {}),
          clearImageModel: command.imageModel === null,
        })
      : await ai.defaults();
    write(view, defaultsText(view));
    return;
  }
  const id = command.id as string;
  if (command.action === 'show') {
    const view = await ai.show({ id });
    write(view, aiText(view));
    return;
  }
  if (command.action === 'set-model') {
    const view = await ai.setModel({
      id,
      role: command.role as string,
      ...(command.model ? { model: command.model } : {}),
    });
    write(view, aiText(view));
    return;
  }
  const page = await ai.usage({
    id,
    limit: command.limit,
    cursor: command.cursor,
  });
  write(
    page,
    [
      `${page.appId}  month since ${page.monthStart.slice(0, 10)}`,
      ...page.monthTotals.map(
        (row) =>
          `  ${row.role}  ${row.providerName}/${row.modelId}  calls=${row.calls}  in=${row.inputTokens}  out=${row.outputTokens}${row.images ? `  images=${row.images}` : ''}`,
      ),
      ...(page.calls.length
        ? page.calls.map(
            (call) =>
              `${call.id}  ${call.createdAt}  ${call.role}  ${call.providerName}/${call.modelId}  ${call.status}${call.errorCode ? `:${call.errorCode}` : ''}  in=${call.inputTokens}  out=${call.outputTokens}  ${call.durationMs}ms`,
          )
        : ['No calls.']),
      ...(page.nextCursor === null ? [] : [`next cursor: ${page.nextCursor}`]),
    ].join('\n'),
  );
}
