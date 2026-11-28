/**
 * Provider model commands: list, add, change and remove models of every kind,
 * and browse or refresh the built-in model catalog.
 */
import {
  countFlag,
  idPositionals,
  invalid,
  onePositional,
  openClient,
  PAGE_OPTIONS,
  pageFlags,
  parseCommandArgs,
  printResult,
  switchFlag,
  textFlag,
  type Flags,
  type OptionSpec,
  type Page,
} from './command-session';
import { CliError } from './error';

const KINDS = ['chat', 'image'] as const;
type Kind = (typeof KINDS)[number];
const MAX_MODEL_ID_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_PROVIDER_ID_LENGTH = 191;
/** `--reset` names and the UpdateModel `reset_fields` value of each. */
const RESET_FIELDS = {
  reasoning: 'reasoning',
  'context-window': 'context_window',
  'max-tokens': 'max_tokens',
  'native-web-search': 'native_web_search',
} as const;
type ResetName = keyof typeof RESET_FIELDS;
type ResetField = (typeof RESET_FIELDS)[ResetName];

/** Chat metadata a model may override; unset fields follow the catalog. */
type ChatSpec = {
  reasoning?: boolean;
  nativeWebSearch?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};
type CatalogLink = { catalogRef?: string; noCatalog?: true };

export type ModelCommand =
  | {
      kind: 'list';
      modelKind?: Kind;
      providerId?: string;
      enabled?: boolean;
      page: Page;
    }
  | { kind: 'set-kind'; id: string; modelKind: Kind }
  | ({
      kind: 'add';
      providerId: string;
      modelId: string;
      modelKind?: Kind;
      name?: string;
      description?: string;
    } & CatalogLink &
      ChatSpec)
  | ({
      kind: 'update';
      id: string;
      modelId?: string;
      name?: string;
      /** An empty string clears it. */
      description?: string;
      resetFields?: ResetField[];
      enabled?: boolean;
    } & CatalogLink &
      ChatSpec)
  | { kind: 'remove'; id: string }
  | { kind: 'reorder'; providerId: string; modelIds: string[] }
  | {
      kind: 'catalog-list';
      providerId?: string;
      modelKind?: Kind;
      query?: string;
      limit: number;
      cursor?: string;
    }
  | { kind: 'catalog-status' }
  | { kind: 'catalog-refresh' }
  | {
      kind: 'catalog-settings';
      autoUpdate?: boolean;
      sourceUrl?: string;
      clearSourceUrl?: true;
    };

function kindFlag(flags: Flags): Kind | undefined {
  const value = textFlag(flags, 'kind');
  if (value !== undefined && !KINDS.includes(value as Kind))
    throw invalid('--kind must be chat or image.');
  return value as Kind | undefined;
}

/** A trimmed text flag of at most `max` code points; rejects a blank one. */
function boundedText(
  flags: Flags,
  name: string,
  max: number,
): string | undefined {
  const value = textFlag(flags, name)?.trim();
  if (value === undefined) return undefined;
  if (!value || Array.from(value).length > max)
    throw invalid(`--${name} must be 1 to ${max} characters.`);
  return value;
}

/** A provider's model id: what is sent to the provider, without spaces. */
export function modelIdFlag(flags: Flags, name: string): string | undefined {
  const value = textFlag(flags, name);
  if (value === undefined) return undefined;
  if (/\s/.test(value) || value.length > MAX_MODEL_ID_LENGTH)
    throw invalid(
      `--${name} must be a model id of at most ${MAX_MODEL_ID_LENGTH} characters without spaces.`,
    );
  return value;
}

export function providerIdFlag(flags: Flags, name: string): string | undefined {
  const value = textFlag(flags, name);
  if (value !== undefined && value.length > MAX_PROVIDER_ID_LENGTH)
    throw invalid(`--${name} is not a valid provider id.`);
  return value;
}

const CATALOG_OPTIONS: OptionSpec = {
  'catalog-ref': { type: 'string' },
  'no-catalog': { type: 'boolean' },
};
const CHAT_SPEC_OPTIONS: OptionSpec = {
  'context-window': { type: 'string' },
  'max-tokens': { type: 'string' },
  reasoning: { type: 'boolean' },
  'no-reasoning': { type: 'boolean' },
  'native-web-search': { type: 'boolean' },
  'no-native-web-search': { type: 'boolean' },
};
const FIELD_OPTIONS: OptionSpec = {
  'model-id': { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
  ...CATALOG_OPTIONS,
  ...CHAT_SPEC_OPTIONS,
};

function catalogLink(flags: Flags): CatalogLink {
  const ref = textFlag(flags, 'catalog-ref');
  if (ref !== undefined && flags['no-catalog'])
    throw invalid('Supply at most one of --catalog-ref and --no-catalog.');
  if (flags['no-catalog']) return { noCatalog: true };
  if (ref === undefined) return {};
  if (ref.length > 300 || !/^[^/\s]+\/\S+$/.test(ref))
    throw invalid(
      '--catalog-ref must look like <catalog-provider-id>/<model-id>, as model catalog list prints it.',
    );
  return { catalogRef: ref };
}

function chatSpec(flags: Flags): ChatSpec {
  const reasoning = switchFlag(flags, 'reasoning', 'no-reasoning');
  const nativeWebSearch = switchFlag(
    flags,
    'native-web-search',
    'no-native-web-search',
  );
  const contextWindow = countFlag(flags, 'context-window');
  const maxTokens = countFlag(flags, 'max-tokens');
  return {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(nativeWebSearch === undefined ? {} : { nativeWebSearch }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function commonFields(flags: Flags) {
  const modelId = modelIdFlag(flags, 'model-id');
  const name = boundedText(flags, 'name', MAX_NAME_LENGTH);
  const description = boundedText(flags, 'description', MAX_DESCRIPTION_LENGTH);
  return {
    ...(modelId === undefined ? {} : { modelId }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...catalogLink(flags),
    ...chatSpec(flags),
  };
}

/** `--reset a,b` (repeatable) or `--reset-all`, as UpdateModel names. */
function resetFields(flags: Flags, spec: ChatSpec): ResetField[] | undefined {
  const names = flags.reset as string[] | undefined;
  if (names !== undefined && flags['reset-all'])
    throw invalid('Supply at most one of --reset and --reset-all.');
  let fields: ResetName[];
  if (flags['reset-all']) fields = Object.keys(RESET_FIELDS) as ResetName[];
  else if (names === undefined) return undefined;
  else {
    const parts = names.flatMap((value) => value.split(','));
    if (parts.some((part) => !Object.hasOwn(RESET_FIELDS, part)))
      throw invalid(
        `--reset takes a comma-separated list of: ${Object.keys(RESET_FIELDS).join(', ')}.`,
      );
    if (new Set(parts).size !== parts.length)
      throw invalid('--reset names the same field more than once.');
    fields = parts as ResetName[];
  }
  const setAndReset = fields.filter(
    (field) =>
      (field === 'reasoning' && spec.reasoning !== undefined) ||
      (field === 'context-window' && spec.contextWindow !== undefined) ||
      (field === 'max-tokens' && spec.maxTokens !== undefined) ||
      (field === 'native-web-search' && spec.nativeWebSearch !== undefined),
  );
  if (setAndReset.length)
    throw invalid(
      `Cannot both set and reset ${setAndReset.map((field) => (field === 'reasoning' || field === 'native-web-search' ? `--${field}/--no-${field}` : `--${field}`)).join(', ')}; drop the flag or the reset.`,
    );
  return fields.map((field) => RESET_FIELDS[field]);
}

/** `--limit` (1–200, default 50 on the platform) and `--cursor`. */
function catalogPage(flags: Flags) {
  const limit = countFlag(flags, 'limit', 200) ?? 0;
  const cursor = textFlag(flags, 'cursor');
  if (cursor !== undefined && !/^\d{1,9}$/.test(cursor))
    throw invalid(
      '--cursor must be the nextCursor printed by the previous page.',
    );
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
}

function parseCatalog(
  args: readonly string[],
  offset: number,
): { command: ModelCommand; flags: Flags } {
  const action = args[offset + 2];
  if (action === 'list') {
    const { flags, positionals } = parseCommandArgs(args, offset, 3, {
      ...PAGE_OPTIONS,
      provider: { type: 'string' },
      kind: { type: 'string' },
      search: { type: 'string' },
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const providerId = textFlag(flags, 'provider');
    if (providerId !== undefined && providerId.length > 80)
      throw invalid('--provider is not a catalog provider id.');
    const modelKind = kindFlag(flags);
    const query = textFlag(flags, 'search')?.trim();
    if (query !== undefined && (!query || query.length > 200))
      throw invalid('--search must be 1 to 200 characters.');
    return {
      command: {
        kind: 'catalog-list',
        ...(providerId === undefined ? {} : { providerId }),
        ...(modelKind === undefined ? {} : { modelKind }),
        ...(query === undefined ? {} : { query }),
        ...catalogPage(flags),
      },
      flags,
    };
  }
  if (action === 'status' || action === 'refresh') {
    const { flags, positionals } = parseCommandArgs(args, offset, 3, {});
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    return { command: { kind: `catalog-${action}` }, flags };
  }
  if (action === 'settings') {
    const { flags, positionals } = parseCommandArgs(args, offset, 3, {
      'auto-update': { type: 'boolean' },
      'no-auto-update': { type: 'boolean' },
      'source-url': { type: 'string' },
      'clear-source-url': { type: 'boolean' },
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const autoUpdate = switchFlag(flags, 'auto-update', 'no-auto-update');
    const sourceUrl = textFlag(flags, 'source-url');
    const clear = flags['clear-source-url'] === true;
    if (sourceUrl !== undefined && clear)
      throw invalid(
        'Supply at most one of --source-url and --clear-source-url.',
      );
    if (sourceUrl !== undefined) {
      let url: URL | undefined;
      try {
        url = new URL(sourceUrl);
      } catch {
        url = undefined;
      }
      if (url?.protocol !== 'https:' || sourceUrl.length > 500)
        throw invalid(
          '--source-url must be an https URL of at most 500 characters.',
        );
    }
    if (autoUpdate === undefined && sourceUrl === undefined && !clear)
      throw invalid(
        'Supply --auto-update, --no-auto-update, --source-url or --clear-source-url.',
      );
    return {
      command: {
        kind: 'catalog-settings',
        ...(autoUpdate === undefined ? {} : { autoUpdate }),
        ...(sourceUrl === undefined ? {} : { sourceUrl }),
        ...(clear ? { clearSourceUrl: true } : {}),
      },
      flags,
    };
  }
  throw invalid('Use hatch model catalog list, status, refresh or settings.');
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseModelCommand(
  args: readonly string[],
  offset: number,
): { command: ModelCommand; flags: Flags } {
  const operation = args[offset + 1];
  if (operation === 'catalog') return parseCatalog(args, offset);
  if (operation === 'list') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      ...PAGE_OPTIONS,
      kind: { type: 'string' },
      provider: { type: 'string' },
      enabled: { type: 'boolean' },
      disabled: { type: 'boolean' },
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const modelKind = kindFlag(flags);
    const providerId = providerIdFlag(flags, 'provider');
    const enabled = switchFlag(flags, 'enabled', 'disabled');
    return {
      command: {
        kind: 'list',
        ...(modelKind ? { modelKind } : {}),
        ...(providerId === undefined ? {} : { providerId }),
        ...(enabled === undefined ? {} : { enabled }),
        page: pageFlags(flags),
      },
      flags,
    };
  }
  if (operation === 'set-kind') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      kind: { type: 'string' },
    });
    if (positionals.length !== 1) throw invalid('Supply exactly one model id.');
    const modelKind = kindFlag(flags);
    if (!modelKind) throw invalid('Supply --kind chat or --kind image.');
    return {
      command: { kind: 'set-kind', id: positionals[0], modelKind },
      flags,
    };
  }
  if (operation === 'add') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      provider: { type: 'string' },
      kind: { type: 'string' },
      ...FIELD_OPTIONS,
    });
    if (positionals.length)
      throw invalid('This command takes no positional arguments.');
    const providerId = providerIdFlag(flags, 'provider');
    const fields = commonFields(flags);
    if (!providerId || !fields.modelId)
      throw invalid('Supply both --provider <id> and --model-id <model-id>.');
    const modelKind = kindFlag(flags);
    const chatFlags = Object.keys(CHAT_SPEC_OPTIONS).filter(
      (name) => flags[name] !== undefined,
    );
    if (modelKind === 'image' && chatFlags.length)
      throw invalid(
        `Image models have no chat metadata; drop ${chatFlags.map((name) => `--${name}`).join(', ')}.`,
      );
    return {
      command: {
        kind: 'add',
        providerId,
        modelId: fields.modelId,
        ...(modelKind ? { modelKind } : {}),
        ...fields,
      },
      flags,
    };
  }
  if (operation === 'update') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      ...FIELD_OPTIONS,
      'clear-description': { type: 'boolean' },
      reset: { type: 'string', multiple: true },
      'reset-all': { type: 'boolean' },
      enable: { type: 'boolean' },
      disable: { type: 'boolean' },
    });
    const id = onePositional(positionals, 'model id');
    const fields = commonFields(flags);
    if (flags['clear-description'] && fields.description !== undefined)
      throw invalid(
        'Supply at most one of --description and --clear-description.',
      );
    const reset = resetFields(flags, fields);
    const enabled = switchFlag(flags, 'enable', 'disable');
    const command = {
      kind: 'update' as const,
      id,
      ...fields,
      ...(flags['clear-description'] ? { description: '' } : {}),
      ...(reset === undefined ? {} : { resetFields: reset }),
      ...(enabled === undefined ? {} : { enabled }),
    };
    if (Object.keys(command).length === 2)
      throw invalid(
        'Supply at least one field to change. Use hatch help model update.',
      );
    return { command, flags };
  }
  if (operation === 'enable' || operation === 'disable') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {});
    return {
      command: {
        kind: 'update',
        id: onePositional(positionals, 'model id'),
        enabled: operation === 'enable',
      },
      flags,
    };
  }
  if (operation === 'remove') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      yes: { type: 'boolean' },
    });
    const id = onePositional(positionals, 'model id');
    if (flags.yes !== true)
      throw invalid('Removing a model cannot be undone; pass --yes.');
    return { command: { kind: 'remove', id }, flags };
  }
  if (operation === 'reorder') {
    const { flags, positionals } = parseCommandArgs(args, offset, 2, {
      provider: { type: 'string' },
    });
    const providerId = providerIdFlag(flags, 'provider');
    if (providerId === undefined)
      throw invalid("Supply --provider <provider-id>, the models' provider.");
    return {
      command: {
        kind: 'reorder',
        providerId,
        modelIds: idPositionals(positionals, 'model id'),
      },
      flags,
    };
  }
  throw invalid(
    'Use hatch model list, add, update, enable, disable, remove, reorder, set-kind or catalog.',
  );
}

export async function runModel(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseModelCommand(args, offset);
  const client = await openClient(flags, signal);
  let result: unknown;
  switch (command.kind) {
    case 'list':
      result = await client.models.list({
        kind: command.modelKind,
        providerId: command.providerId,
        enabled: command.enabled,
        ...command.page,
      });
      break;
    case 'set-kind':
      result = await client.models.setKind({
        id: command.id,
        kind: command.modelKind,
      });
      break;
    case 'add': {
      const { kind: _command, modelKind, ...fields } = command;
      result = await client.models.create({ ...fields, kind: modelKind });
      break;
    }
    case 'update': {
      const { kind: _command, ...fields } = command;
      result = await client.models.update(fields);
      break;
    }
    case 'remove':
      result = await client.models.delete({ id: command.id });
      break;
    case 'reorder':
      result = await client.models.reorder(command);
      break;
    case 'catalog-list':
      result = await client.catalog.models({
        providerId: command.providerId,
        query: command.query,
        kind: command.modelKind,
        limit: command.limit,
        cursor: command.cursor,
      });
      break;
    case 'catalog-status':
      result = await client.catalog.status();
      break;
    case 'catalog-refresh': {
      process.stderr.write('Checking the model catalog source for updates.\n');
      const refreshed = await client.catalog.refresh();
      if (refreshed.outcome === 'failed')
        throw new CliError(
          'catalog_refresh_failed',
          `The model catalog could not be refreshed: ${refreshed.status.lastError ?? 'no details'}. The catalog in use is unchanged.`,
          7,
          undefined,
          refreshed,
        );
      result = refreshed;
      break;
    }
    case 'catalog-settings':
      result = await client.catalog.updateSettings({
        autoUpdate: command.autoUpdate,
        sourceUrl: command.sourceUrl,
        clearSourceUrl: command.clearSourceUrl,
      });
      break;
  }
  printResult(result, flags);
}
