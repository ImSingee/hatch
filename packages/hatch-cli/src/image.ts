/** Image models, image generation and App icon commands. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addAbortSignal } from 'node:stream';
import { parseArgs } from 'node:util';
import { credentialHeaders, platformClient } from './client';
import { configPath, resolveCredential } from './config';
import { argumentsError, CliError } from './error';
import { readTextInput } from './input';

export const MAX_ICON_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PROMPT_LENGTH = 4000;
const CANDIDATE_ID_RE = /^[a-f0-9]{32}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const MAX_MODEL_NAME_LENGTH = 200;
export const MAX_MODEL_DESCRIPTION_LENGTH = 200;
const QUALITIES = ['low', 'medium', 'high'] as const;

type Flags = Record<string, string | boolean | undefined>;
type OptionSpec = Record<string, { type: 'string' | 'boolean' }>;
const invalid = (message: string) => new CliError('invalid_arguments', message);

export type ImageCommand =
  | { kind: 'model-list' }
  | {
      kind: 'model-add';
      providerId: string;
      modelId: string;
      name?: string;
      description?: string;
    }
  | {
      kind: 'model-update';
      id: string;
      modelId?: string;
      name?: string;
      /** Empty string clears it. */
      description?: string;
    }
  | { kind: 'model-remove'; id: string }
  | {
      kind: 'generate';
      imageModelId?: string;
      prompt?: string;
      promptFile?: string;
      count: number;
      quality?: (typeof QUALITIES)[number];
      glyphTile?: string;
      outputDir?: string;
    }
  | { kind: 'icon-get'; id: string }
  | { kind: 'icon-set'; id: string; file?: string; candidateId?: string }
  | { kind: 'icon-clear'; id: string };

const GLOBALS: OptionSpec = {
  json: { type: 'boolean' },
  config: { type: 'string' },
  profile: { type: 'string' },
  workdir: { type: 'string' },
  timeout: { type: 'string' },
};

function parse(
  args: readonly string[],
  offset: number,
  depth: number,
  options: OptionSpec,
  positionals: number,
  positionalLabel = 'App id or slug',
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args.slice(0, offset), ...args.slice(offset + depth)],
      options: { ...GLOBALS, ...options },
      allowPositionals: true,
    });
  } catch (error) {
    throw argumentsError(error, 'image');
  }
  if (parsed.positionals.length !== positionals)
    throw invalid(
      positionals
        ? `Supply exactly one ${positionalLabel}.`
        : 'This command takes no positional arguments.',
    );
  return { flags: parsed.values as Flags, positionals: parsed.positionals };
}

function text(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value)
    throw invalid(`--${name} must not be empty.`);
  return value;
}

function modelFields(flags: Flags) {
  const modelId = text(flags, 'model-id');
  if (modelId !== undefined && !MODEL_ID_RE.test(modelId))
    throw invalid('--model-id is not a valid model id.');
  const name = text(flags, 'name')?.trim();
  if (
    name !== undefined &&
    (!name || promptLength(name) > MAX_MODEL_NAME_LENGTH)
  )
    throw invalid(`--name must be 1 to ${MAX_MODEL_NAME_LENGTH} characters.`);
  const description = text(flags, 'description')?.trim();
  if (description === '') throw invalid('--description must not be blank.');
  if (
    description !== undefined &&
    promptLength(description) > MAX_MODEL_DESCRIPTION_LENGTH
  )
    throw invalid(
      `--description must be at most ${MAX_MODEL_DESCRIPTION_LENGTH} characters.`,
    );
  return { modelId, name, description };
}

const MODEL_FIELD_OPTIONS: OptionSpec = {
  'model-id': { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
};

/** Unicode code points, the unit the public API limits prompts in. */
function promptLength(prompt: string): number {
  return Array.from(prompt).length;
}

/** Map argv to one command; rejects anything ambiguous before any RPC. */
export function parseImageCommand(
  args: readonly string[],
  offset: number,
): { command: ImageCommand; flags: Flags } {
  const [name, operation, action] = args.slice(offset);
  if (name === 'image-model') {
    if (operation === 'list') {
      const { flags } = parse(args, offset, 2, {}, 0);
      return { command: { kind: 'model-list' }, flags };
    }
    if (operation === 'add') {
      const { flags } = parse(
        args,
        offset,
        2,
        { provider: { type: 'string' }, ...MODEL_FIELD_OPTIONS },
        0,
      );
      const providerId = text(flags, 'provider');
      const fields = modelFields(flags);
      if (!providerId || !fields.modelId)
        throw invalid('Supply both --provider <id> and --model-id <model-id>.');
      return {
        command: {
          kind: 'model-add',
          providerId,
          modelId: fields.modelId,
          name: fields.name,
          description: fields.description,
        },
        flags,
      };
    }
    if (operation === 'update') {
      const { flags, positionals } = parse(
        args,
        offset,
        2,
        { ...MODEL_FIELD_OPTIONS, 'clear-description': { type: 'boolean' } },
        1,
        'image model id',
      );
      const fields = modelFields(flags);
      if (flags['clear-description'] && fields.description !== undefined)
        throw invalid('Use either --description or --clear-description.');
      const description = flags['clear-description'] ? '' : fields.description;
      if (
        fields.modelId === undefined &&
        fields.name === undefined &&
        description === undefined
      )
        throw invalid(
          'Supply at least one of --model-id, --name, --description and --clear-description.',
        );
      return {
        command: {
          kind: 'model-update',
          id: positionals[0],
          modelId: fields.modelId,
          name: fields.name,
          description,
        },
        flags,
      };
    }
    if (operation === 'remove') {
      const { flags, positionals } = parse(
        args,
        offset,
        2,
        {},
        1,
        'image model id',
      );
      return { command: { kind: 'model-remove', id: positionals[0] }, flags };
    }
    throw invalid('Use hatch image-model list, add, update or remove.');
  }
  if (name === 'image') {
    if (operation !== 'generate') throw invalid('Use hatch image generate.');
    const { flags } = parse(
      args,
      offset,
      2,
      {
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        count: { type: 'string' },
        quality: { type: 'string' },
        'glyph-tile': { type: 'string' },
        'output-dir': { type: 'string' },
        model: { type: 'string' },
      },
      0,
    );
    const prompt = text(flags, 'prompt');
    const promptFile = text(flags, 'prompt-file');
    if ((prompt === undefined) === (promptFile === undefined))
      throw invalid('Supply exactly one of --prompt and --prompt-file.');
    if (prompt !== undefined && promptLength(prompt) > MAX_PROMPT_LENGTH)
      throw invalid(`--prompt exceeds ${MAX_PROMPT_LENGTH} characters.`);
    const countText = text(flags, 'count');
    const count = countText === undefined ? 1 : Number(countText);
    if (!/^[1-4]$/.test(countText ?? '1'))
      throw invalid('--count must be an integer from 1 to 4.');
    const quality = text(flags, 'quality');
    if (
      quality !== undefined &&
      !QUALITIES.includes(quality as (typeof QUALITIES)[number])
    )
      throw invalid('--quality must be low, medium or high.');
    const glyphTile = text(flags, 'glyph-tile');
    const imageModelId = text(flags, 'model');
    if (imageModelId !== undefined && imageModelId.length > 191)
      throw invalid('--model is not a valid image model id.');
    if (glyphTile !== undefined && !/^#[0-9a-fA-F]{6}$/.test(glyphTile))
      throw invalid('--glyph-tile must be a #RRGGBB colour.');
    return {
      command: {
        kind: 'generate',
        imageModelId,
        prompt,
        promptFile,
        count,
        quality: quality as (typeof QUALITIES)[number] | undefined,
        glyphTile,
        outputDir: text(flags, 'output-dir'),
      },
      flags,
    };
  }
  if (name === 'app' && operation === 'icon') {
    if (action === 'get' || action === 'clear') {
      const { flags, positionals } = parse(args, offset, 3, {}, 1);
      return { command: { kind: `icon-${action}`, id: positionals[0] }, flags };
    }
    if (action === 'set') {
      const { flags, positionals } = parse(
        args,
        offset,
        3,
        { file: { type: 'string' }, candidate: { type: 'string' } },
        1,
      );
      const file = text(flags, 'file');
      const candidateId = text(flags, 'candidate');
      if ((file === undefined) === (candidateId === undefined))
        throw invalid('Supply exactly one of --file and --candidate.');
      if (candidateId !== undefined && !CANDIDATE_ID_RE.test(candidateId))
        throw invalid('--candidate is not a valid candidate id.');
      return {
        command: { kind: 'icon-set', id: positionals[0], file, candidateId },
        flags,
      };
    }
    throw invalid('Use hatch app icon get, set or clear.');
  }
  throw invalid('Unknown command. Use hatch help.');
}

/** Reject files the platform would refuse, without sending them. */
export function assertIconFile(bytes: Uint8Array): void {
  if (!bytes.byteLength)
    throw new CliError('invalid_input', '--file is empty.');
  if (bytes.byteLength > MAX_ICON_FILE_BYTES)
    throw new CliError('input_too_large', '--file exceeds 4 MB.');
  const head = Buffer.from(bytes.subarray(0, 12));
  const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const webp =
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP';
  if (!png && !jpeg && !webp)
    throw new CliError(
      'invalid_input',
      '--file must be a PNG, JPEG or WebP image.',
    );
}

async function readBinary(
  path: string,
  workdir: string,
  signal: AbortSignal,
): Promise<Buffer> {
  if (path !== '-')
    return readFile(resolve(workdir, path), { signal }).catch(() => {
      throw new CliError('input_unreadable', 'Cannot read --file.');
    });
  if (process.stdin.isTTY)
    throw new CliError('stdin_required', 'Pipe an image for --file -.');
  addAbortSignal(
    AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    process.stdin,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_ICON_FILE_BYTES)
        throw new CliError('input_too_large', '--file exceeds 4 MB.');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'input_cancelled',
      'Input cancelled or timed out.',
      signal.aborted ? 130 : 7,
    );
  }
  return Buffer.concat(chunks);
}

export async function runImage(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
) {
  const { command, flags } = parseImageCommand(args, offset);
  const seconds =
    flags.timeout === undefined
      ? command.kind === 'generate'
        ? 300
        : 60
      : Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600)
    throw new CliError(
      'invalid_timeout',
      '--timeout must be between 0 and 3600 seconds.',
    );
  if (
    flags.profile !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(flags.profile))
  )
    throw invalid('Invalid profile name.');
  if ([flags.config, flags.workdir].includes(''))
    throw invalid('Paths must not be empty.');
  const workdir = String(flags.workdir ?? '.');
  const credential = await resolveCredential(
    process.env,
    configPath(process.env, flags.config as string | undefined),
    flags.profile as string | undefined,
  );
  const timeoutMs = Math.ceil(seconds * 1000);
  const client = platformClient(credential, timeoutMs, signal);

  let result: unknown;
  if (command.kind === 'model-list') result = await client.images.models();
  else if (command.kind === 'model-add')
    result = await client.images.createModel({
      providerId: command.providerId,
      modelId: command.modelId,
      name: command.name,
      description: command.description,
    });
  else if (command.kind === 'model-update')
    result = await client.images.updateModel({
      id: command.id,
      modelId: command.modelId,
      name: command.name,
      description: command.description,
    });
  else if (command.kind === 'model-remove')
    result = await client.images.deleteModel({ id: command.id });
  else if (command.kind === 'icon-get')
    result = await client.apps.icon.get({ id: command.id });
  else if (command.kind === 'icon-clear')
    result = await client.apps.icon.clear({ id: command.id });
  else if (command.kind === 'icon-set') {
    if (command.candidateId !== undefined)
      result = await client.apps.icon.set({
        id: command.id,
        candidateId: command.candidateId,
      });
    else {
      const image = await readBinary(command.file!, workdir, signal);
      assertIconFile(image);
      result = await client.apps.icon.set({ id: command.id, image });
    }
  } else {
    const prompt =
      command.prompt ??
      (await readTextInput(
        command.promptFile === '-'
          ? '-'
          : resolve(workdir, command.promptFile!),
        signal,
        MAX_PROMPT_LENGTH * 4,
      ));
    if (!prompt.trim() || promptLength(prompt) > MAX_PROMPT_LENGTH)
      throw new CliError(
        'invalid_input',
        `The prompt must be 1 to ${MAX_PROMPT_LENGTH} characters.`,
      );
    // Prepare the directory before spending provider credit on images that
    // could not be saved.
    const directory =
      command.outputDir === undefined
        ? undefined
        : resolve(workdir, command.outputDir);
    if (directory)
      await mkdir(directory, { recursive: true }).catch(() => {
        throw new CliError('output_unwritable', 'Cannot create --output-dir.');
      });
    process.stderr.write('Generating images; this can take a minute.\n');
    const generated = await client.images.generate({
      prompt,
      count: command.count,
      quality: command.quality,
      glyphTile: command.glyphTile,
      imageModelId: command.imageModelId,
    });
    const candidates: { id: string; path: string; file?: string }[] = [];
    const unsaved: string[] = [];
    for (const candidate of generated.candidates) {
      if (!directory) {
        candidates.push(candidate);
        continue;
      }
      const file = resolve(directory, `${candidate.id}.png`);
      const saved = await fetch(`${credential.url}${candidate.path}`, {
        headers: credentialHeaders(credential),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
        .then(async (response) => {
          if (!response.ok) return false;
          await writeFile(file, Buffer.from(await response.arrayBuffer()));
          return true;
        })
        .catch(() => false);
      if (saved) candidates.push({ ...candidate, file });
      else {
        candidates.push(candidate);
        unsaved.push(candidate.id);
      }
    }
    result = {
      imageModelId: generated.imageModelId,
      modelId: generated.modelId,
      candidates,
    };
    // The images exist and were paid for: report every candidate so the
    // caller can use them by id instead of generating again.
    if (unsaved.length)
      throw new CliError(
        'download_failed',
        `Generated candidates ${candidates.map((item) => item.id).join(', ')} but could not save ${unsaved.join(', ')} to --output-dir. All of them stay available by id for one day; do not generate again.`,
        7,
        undefined,
        result,
      );
  }
  process.stdout.write(
    `${JSON.stringify(result, null, flags.json ? undefined : 2)}\n`,
  );
}
