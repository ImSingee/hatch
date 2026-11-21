import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectSourceToolchain,
  sourceToolchainReader,
  type SourceToolchainFile,
} from './source-toolchain';

function reader(files: SourceToolchainFile[]) {
  return async (file: SourceToolchainFile) =>
    files.includes(file) ? '' : null;
}

describe('detectSourceToolchain', () => {
  it('selects the Node toolchain for a pnpm lockfile alone', async () => {
    await expect(
      detectSourceToolchain(reader(['pnpm-lock.yaml'])),
    ).resolves.toBe('node');
  });

  it('keeps Deno sources, including incomplete ones, on the Deno toolchain', async () => {
    await expect(
      detectSourceToolchain(reader(['deno.json', 'deno.lock'])),
    ).resolves.toBe('deno');
    // The Deno dependency validator reports which of its files is missing.
    await expect(detectSourceToolchain(reader(['deno.json']))).resolves.toBe(
      'deno',
    );
    await expect(detectSourceToolchain(reader(['deno.lock']))).resolves.toBe(
      'deno',
    );
  });

  it('rejects a source that mixes both lockfile families and names the files', async () => {
    await expect(
      detectSourceToolchain(
        reader(['pnpm-lock.yaml', 'deno.json', 'deno.lock']),
      ),
    ).rejects.toThrow(
      /Remove deno\.json and deno\.lock to build with pnpm, or remove pnpm-lock\.yaml/,
    );
    await expect(
      detectSourceToolchain(reader(['pnpm-lock.yaml', 'deno.lock'])),
    ).rejects.toThrow(/Remove deno\.lock to build with pnpm/);
  });

  it('rejects a source without any lockfile and asks for pnpm-lock.yaml', async () => {
    await expect(detectSourceToolchain(reader([]))).rejects.toThrow(
      /no dependency lockfile.*pnpm-lock\.yaml/s,
    );
  });

  it('rejects a lockfile that is not a regular file instead of reading it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-toolchain-'));
    try {
      // Reading a named pipe with no writer would never return.
      execFileSync('mkfifo', [path.join(root, 'pnpm-lock.yaml')]);
      await expect(
        detectSourceToolchain(sourceToolchainReader(root)),
      ).rejects.toThrow('pnpm-lock.yaml must be a regular file.');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
