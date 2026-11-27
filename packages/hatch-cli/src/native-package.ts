/** Download a native App's signed package and print the runtime trust. */
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeTrustView } from './client';
import {
  invalid,
  onePositional,
  openClient,
  parseCommandArgs,
  textFlag,
  timeoutSeconds,
  type Flags,
} from './command-session';
import { CliError } from './error';

export type NativePackageCommand =
  | { kind: 'package'; app: string; out: string; force: boolean }
  | { kind: 'runtime-trust'; outDir: string | undefined };

/** Relative paths are read against `--workdir` (default: the cwd). */
function local(flags: Flags, file: string): string {
  return path.resolve(textFlag(flags, 'workdir') ?? '.', file);
}

/** Map argv to one command; rejects anything unusable before any RPC. */
export function parseNativePackageCommand(
  args: readonly string[],
  offset: number,
): { command: NativePackageCommand; flags: Flags } {
  const operation = args[offset + 1];
  // Global flags too: a bad one must fail before a Run credential refresh.
  const checked = (parsed: { flags: Flags; positionals: string[] }) => {
    textFlag(parsed.flags, 'workdir');
    timeoutSeconds(parsed.flags);
    return parsed;
  };
  if (operation === 'package') {
    const { flags, positionals } = checked(
      parseCommandArgs(args, offset, 2, {
        out: { type: 'string' },
        force: { type: 'boolean' },
      }),
    );
    const app = onePositional(positionals, 'App ID or slug to app package');
    const out = textFlag(flags, 'out');
    if (out === undefined)
      throw invalid('Supply --out <path> (or --out - for stdout).');
    if (out === '-' && flags.json)
      throw invalid(
        '--out - writes the package to stdout; it cannot be combined with --json.',
      );
    if (out === '-' && flags.force)
      throw invalid('--force applies only to a file named by --out.');
    return {
      command: { kind: 'package', app, out, force: flags.force === true },
      flags,
    };
  }
  if (operation === 'runtime-trust') {
    const { flags, positionals } = checked(
      parseCommandArgs(args, offset, 2, {
        'out-dir': { type: 'string' },
      }),
    );
    if (positionals.length)
      throw invalid(
        'app runtime-trust takes no App: the trust is the instance’s.',
      );
    return {
      command: { kind: 'runtime-trust', outDir: textFlag(flags, 'out-dir') },
      flags,
    };
  }
  throw invalid('Use hatch app package or hatch app runtime-trust.');
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

/**
 * Write `bytes` to `file` whole, so no reader sees half of it. Without
 * `replace` an existing file is never overwritten, also one another process
 * created while the package downloaded (`output_exists`).
 */
async function writeWhole(
  file: string,
  bytes: Uint8Array,
  replace: boolean,
): Promise<void> {
  const staged = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(staged, bytes, { flag: 'wx' });
    if (replace) await rename(staged, file);
    else
      await link(staged, file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
        throw new CliError(
          'output_exists',
          `${file} already exists; pass --force to replace it.`,
          6,
        );
      });
  } finally {
    await rm(staged, { force: true });
  }
}

/** The files `--out-dir` holds, as `nsh verify --root/--revocations` read them. */
export function trustFiles(trust: RuntimeTrustView): Record<string, string> {
  const files: Record<string, string> = {};
  for (const root of trust.roots)
    files[`root-${root.keyId}.pub`] = `${root.publicKey}\n`;
  for (const key of trust.releaseKeys)
    files[`release-${key.keyId}.cert`] = `${key.certificate}\n`;
  if (trust.revocations)
    files['revocations.json'] = `${trust.revocations.signed}\n`;
  return files;
}

export function trustText(trust: RuntimeTrustView): string {
  if (!trust.initialized)
    return 'No native package has been signed on this instance yet; its keys are created with the first native deployment.';
  return [
    `App ids: ${trust.appIdPattern}`,
    ...trust.roots.map((root) => `root ${root.keyId}  ${root.publicKey}`),
    ...trust.releaseKeys.map(
      (key) =>
        `release ${key.keyId}${key.active ? ' (active)' : ''}${
          key.revoked ? ' (revoked)' : ''
        }  signs ${key.apps.join(', ')} from ${key.notBefore} to ${key.notAfter}`,
    ),
    trust.revocations
      ? `revocations: list ${trust.revocations.sequence}, ${trust.revocations.keyIds.length} key(s), ${trust.revocations.packageSha256s.length} package(s)`
      : 'revocations: none',
  ].join('\n');
}

export async function runNativePackage(
  args: readonly string[],
  offset: number,
  signal: AbortSignal,
): Promise<void> {
  const { command, flags } = parseNativePackageCommand(args, offset);
  if (command.kind === 'package') {
    const target = command.out === '-' ? null : local(flags, command.out);
    // Checked before the download too, so a refusal costs no download.
    if (target && !command.force && (await exists(target)))
      throw new CliError(
        'output_exists',
        `${command.out} already exists; pass --force to replace it.`,
        6,
      );
    const client = await openClient(flags, signal);
    const result = await client.apps.nativePackage.get({ id: command.app });
    const digest = createHash('sha256').update(result.bytes).digest('hex');
    if (
      result.bytes.length !== result.package.size ||
      digest !== result.package.sha256
    )
      throw new CliError(
        'package_incomplete',
        'The downloaded package does not match the size and SHA-256 the platform announced; nothing was written. Try again.',
        7,
      );
    if (!target) {
      process.stdout.write(result.bytes);
      return;
    }
    await writeWhole(target, result.bytes, command.force);
    const view = { ...result.package, path: target };
    process.stdout.write(
      flags.json
        ? `${JSON.stringify(view)}\n`
        : `Wrote ${target}\n${view.nshAppId} build ${view.build} (version ${view.version}, deployment ${view.deploymentId}), ${view.size} bytes, sha256 ${view.sha256}, signed by release key ${view.keyId}${view.bytecode ? ', with bytecode' : ', source only'}\n`,
    );
    return;
  }
  const client = await openClient(flags, signal);
  const trust = await client.apps.nativePackage.trust();
  const written: string[] = [];
  if (command.outDir) {
    const dir = local(flags, command.outDir);
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(trustFiles(trust))) {
      const file = path.join(dir, name);
      // A file left by an earlier run is replaced.
      await writeWhole(file, Buffer.from(content, 'utf8'), true);
      written.push(file);
    }
  }
  const view = command.outDir ? { ...trust, files: written } : trust;
  process.stdout.write(
    flags.json
      ? `${JSON.stringify(view)}\n`
      : `${trustText(trust)}${written.length ? `\nWrote ${written.join(', ')}` : ''}\n`,
  );
}
