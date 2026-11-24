/**
 * AI provider commands: the endpoints and API keys the Agent and image
 * generation call. API keys are read only from a file or stdin and never
 * printed.
 */
import { resolve } from 'node:path';
import {
  invalid,
  listFlag,
  onePositional,
  openClient,
  parseCommandArgs,
  printResult,
  switchFlag,
  textFlag,
  type Flags,
} from './command-session';
import { CliError } from './error';
import { readTextInput } from './input';
import { modelIdFlag } from './model';

export const API_TYPES = [
  'anthropic-messages',
  'openai-responses',
  'openai-completions',
] as const;
type ApiType = (typeof API_TYPES)[number];
const MAX_API_KEY_LENGTH = 4096;
const MAX_MODELS = 100;

/** Provider fields shared by add and update; unset ones are left out. */
type ProviderFields = {
  name?: string;
  apiType?: ApiType;
  baseUrl?: string;
  /** `--api-key-file`: a path or `-` for stdin, read when the command runs. */
  apiKeyFile?: string;
};

export type ProviderCommand =
  | { kind: 'list' }
  | { kind: 'get'; id: string }
  | { kind: 'catalog'; search?: string }
  | ({
      kind: 'add';
      catalogProviderId?: string;
      apiKeyFile: string;
      /** Chat models to add. */
      modelIds: string[];
      /** Image models to add. */
      imageModelIds: string[];
      noModels: boolean;
    } & ProviderFields)
  | ({
      kind: 'update';
      id: string;
      enabled?: boolean;
      catalogProviderId?: string;
      clearCatalogProvider?: true;
    } & ProviderFields)
  | { kind: 'remove'; id: string }
  | { kind: 'test'; id: string; modelId?: string }
  | { kind: 'fetch-models'; id: string };

const FIELD_OPTIONS = {
  name: { type: 'string' },
  'api-type': { type: 'string' },
  'base-url': { type: 'string' },
  'api-key-file': { type: 'string' },
  // Declared only to refuse it with a pointer to --api-key-file.
  'api-key': { type: 'string' },
  catalog: { type: 'string' },
} as const;

function providerFields(flags: Flags): ProviderFields {
  if (flags['api-key'] !== undefined)
    throw invalid(
      'API keys are never taken as an argument, which shell history and process lists would record. Write the key to a file or pipe it, and pass --api-key-file <path|->.',
    );
  const name = textFlag(flags, 'name')?.trim();
  if (name !== undefined && (!name || Array.from(name).length > 120))
    throw invalid('--name must be 1 to 120 characters.');
  const apiType = textFlag(flags, 'api-type');
  if (apiType !== undefined && !API_TYPES.includes(apiType as ApiType))
    throw invalid(`--api-type must be one of: ${API_TYPES.join(', ')}.`);
  const baseUrl = textFlag(flags, 'base-url');
  if (baseUrl !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(baseUrl);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      !['http:', 'https:'].includes(url.protocol) ||
      baseUrl.length > 500
    )
      throw invalid(
        '--base-url must be an http or https URL of at most 500 characters.',
      );
  }
  const apiKeyFile = textFlag(flags, 'api-key-file');
  return {
    ...(name === undefined ? {} : { name }),
    ...(apiType === undefined ? {} : { apiType: apiType as ApiType }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKeyFile === undefined ? {} : { apiKeyFile }),
  };
}

function catalogProviderFlag(flags: Flags): string | undefined {
  const value = textFlag(flags, 'catalog');
  if (value !== undefined && (value.length > 80 || /\s/.test(value)))
    throw invalid(
      '--catalog must be a catalog provider id, as provider catalog prints it.',
    );
  return value;
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseProviderCommand(
  args: readonly string[],
  offset: number,
): { command: ProviderCommand; flags: Flags } {
  const operation = args[offset + 1];
  if (operation === 'list') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {});
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    return { command: { kind: 'list' }, flags };
  }
  if (operation === 'get' || operation === 'fetch-models') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {});
    return {
      command: {
        kind: operation,
        id: onePositional(positionals, 'provider id'),
      },
      flags,
    };
  }
  if (operation === 'catalog') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      search: { type: 'string' },
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const search = textFlag(flags, 'search')?.trim();
    if (search === '') throw invalid('--search must not be blank.');
    return {
      command: { kind: 'catalog', ...(search ? { search } : {}) },
      flags,
    };
  }
  if (operation === 'add') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      ...FIELD_OPTIONS,
      model: { type: 'string', multiple: true },
      'image-model': { type: 'string', multiple: true },
      'no-models': { type: 'boolean' },
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const fields = providerFields(flags);
    const catalogProviderId = catalogProviderFlag(flags);
    if (catalogProviderId === undefined) {
      const missing = (['name', 'api-type', 'base-url'] as const).filter(
        (name) => flags[name] === undefined,
      );
      if (missing.length)
        throw invalid(
          `Without --catalog, supply ${missing.map((name) => `--${name}`).join(', ')}; or start from a preset with --catalog <catalog-provider-id> (see hatch provider catalog).`,
        );
    }
    if (!fields.apiKeyFile)
      throw invalid('Supply the API key with --api-key-file <path|->.');
    const modelIds = listFlag(flags, 'model') ?? [];
    for (const modelId of modelIds) modelIdFlag({ model: modelId }, 'model');
    const imageModelIds = listFlag(flags, 'image-model') ?? [];
    for (const modelId of imageModelIds)
      modelIdFlag({ 'image-model': modelId }, 'image-model');
    const noModels = flags['no-models'] === true;
    if (noModels && (modelIds.length || imageModelIds.length))
      throw invalid(
        'Supply at most one of --no-models and --model or --image-model.',
      );
    if (modelIds.length + imageModelIds.length > MAX_MODELS)
      throw invalid(
        `Supply at most ${MAX_MODELS} --model and --image-model flags together.`,
      );
    return {
      command: {
        kind: 'add',
        ...fields,
        apiKeyFile: fields.apiKeyFile,
        ...(catalogProviderId === undefined ? {} : { catalogProviderId }),
        modelIds,
        imageModelIds,
        noModels,
      },
      flags,
    };
  }
  if (operation === 'update') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      ...FIELD_OPTIONS,
      'clear-catalog': { type: 'boolean' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    });
    const id = onePositional(positionals, 'provider id');
    const fields = providerFields(flags);
    const enabled = switchFlag(flags, 'enable', 'disable');
    const catalogProviderId = catalogProviderFlag(flags);
    const clear = flags['clear-catalog'] === true;
    if (catalogProviderId !== undefined && clear)
      throw invalid('Supply at most one of --catalog and --clear-catalog.');
    const command = {
      kind: 'update' as const,
      id,
      ...fields,
      ...(enabled === undefined ? {} : { enabled }),
      ...(catalogProviderId === undefined ? {} : { catalogProviderId }),
      ...(clear ? { clearCatalogProvider: true as const } : {}),
    };
    if (Object.keys(command).length === 2)
      throw invalid(
        'Supply at least one field to change. Use hatch help provider update.',
      );
    return { command, flags };
  }
  if (operation === 'remove') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      yes: { type: 'boolean' },
    });
    const id = onePositional(positionals, 'provider id');
    if (flags.yes !== true)
      throw invalid(
        'Removing a provider deletes its API key and every model under it and cannot be undone; pass --yes.',
      );
    return { command: { kind: 'remove', id }, flags };
  }
  if (operation === 'test') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      model: { type: 'string' },
    });
    const id = onePositional(positionals, 'provider id');
    const modelId = modelIdFlag(flags, 'model');
    return {
      command: { kind: 'test', id, ...(modelId ? { modelId } : {}) },
      flags,
    };
  }
  throw invalid(
    'Use hatch provider list, get, catalog, add, update, remove, test or fetch-models.',
  );
}

/** Read the API key from a file or stdin, trimmed, never from argv. */
async function readApiKey(
  path: string,
  workdir: string,
  signal: AbortSignal,
): Promise<string> {
  if (path === '-' && process.stdin.isTTY)
    throw new CliError(
      'stdin_required',
      'Pipe the API key for --api-key-file -.',
    );
  let text: string;
  try {
    text = await readTextInput(
      path === '-' ? '-' : resolve(workdir, path),
      signal,
      MAX_API_KEY_LENGTH * 4,
    );
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const reasons: Record<string, string> = {
      input_unreadable: 'Cannot read --api-key-file.',
      input_too_large: `--api-key-file holds more than an API key (at most ${MAX_API_KEY_LENGTH} characters).`,
      invalid_input: '--api-key-file must be UTF-8 text.',
    };
    throw new CliError(
      error.code,
      reasons[error.code] ?? error.message,
      error.exitCode,
    );
  }
  const key = text.trim();
  if (!key) throw new CliError('invalid_input', '--api-key-file is empty.');
  if (key.length > MAX_API_KEY_LENGTH || /\s/.test(key))
    throw new CliError(
      'invalid_input',
      `--api-key-file must hold one API key of at most ${MAX_API_KEY_LENGTH} characters, without spaces or line breaks inside it.`,
    );
  return key;
}

/** Keep a key the platform might echo out of the printed error. */
async function withoutKey<T>(key: string | undefined, call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (!key || !(error instanceof CliError) || !error.message.includes(key))
      throw error;
    throw new CliError(
      error.code,
      error.message.replaceAll(key, '[redacted]'),
      error.exitCode,
      error.httpStatus,
    );
  }
}

function matches(search: string, values: (string | null)[]) {
  const text = values.join(' ').toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}

export async function runProvider(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseProviderCommand(args, offset);
  if (flags.workdir === '') throw invalid('Paths must not be empty.');
  const workdir = String(flags.workdir ?? '.');
  const client = await openClient(flags, signal);
  let result: unknown;
  switch (command.kind) {
    case 'list':
      result = await client.providers.list();
      break;
    case 'get':
      result = await client.providers.get({ id: command.id });
      break;
    case 'catalog': {
      const { search } = command;
      const providers = await client.catalog.providers();
      result = {
        providers: search
          ? providers.filter((provider) =>
              matches(search, [
                provider.id,
                provider.name,
                provider.description,
              ]),
            )
          : providers,
      };
      break;
    }
    case 'add': {
      const apiKey = await readApiKey(command.apiKeyFile, workdir, signal);
      result = await withoutKey(apiKey, () =>
        client.providers.create({
          catalogProviderId: command.catalogProviderId,
          name: command.name,
          apiType: command.apiType,
          baseUrl: command.baseUrl,
          apiKey,
          models: [
            ...command.modelIds.map((modelId) => ({ modelId, kind: 'chat' })),
            ...command.imageModelIds.map((modelId) => ({
              modelId,
              kind: 'image',
            })),
          ],
          noModels: command.noModels,
        }),
      );
      break;
    }
    case 'update': {
      const apiKey =
        command.apiKeyFile === undefined
          ? undefined
          : await readApiKey(command.apiKeyFile, workdir, signal);
      result = await withoutKey(apiKey, () =>
        client.providers.update({
          id: command.id,
          name: command.name,
          apiType: command.apiType,
          baseUrl: command.baseUrl,
          apiKey,
          enabled: command.enabled,
          catalogProviderId: command.catalogProviderId,
          clearCatalogProvider: command.clearCatalogProvider,
        }),
      );
      break;
    }
    case 'remove':
      result = await client.providers.delete({ id: command.id });
      break;
    case 'test': {
      process.stderr.write('Sending one short prompt to the provider.\n');
      const tested = await client.providers.test({
        id: command.id,
        modelId: command.modelId,
      });
      if (!tested.ok)
        throw new CliError(
          'provider_test_failed',
          `The provider failed the test with model ${tested.modelId} after ${tested.latencyMs} ms: ${tested.error ?? 'no details'}`,
          7,
          undefined,
          tested,
        );
      result = tested;
      break;
    }
    case 'fetch-models':
      result = await client.providers.remoteModels({ id: command.id });
      break;
  }
  printResult(result, flags);
}
