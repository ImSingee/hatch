/**
 * Write the tree of one commit into an empty directory, byte for byte as it
 * was committed, without touching the repository's own index or work tree.
 *
 * The files come from the raw objects (`ls-tree` for the entries, `cat-file
 * --batch` for the blobs), not from a checkout: no attribute, filter or
 * host setting applies. `core.autocrlf`, `eol`, `ident`, smudge filters
 * (Git LFS) and replace refs therefore change nothing, and neither do the
 * archive-only `export-ignore` and `export-subst`. The CLI's local build and
 * the Builder's source download both use it, so on any host both build the
 * same bytes.
 *
 * Regular files keep their executable bit and symbolic links stay links.
 * Submodules (gitlinks) are not written: their contents are not in this
 * repository.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class CommitCheckoutError extends Error {
  constructor(
    message: string,
    readonly missingCommit: boolean,
  ) {
    super(message);
    this.name = 'CommitCheckoutError';
  }
}

/** Run Git to completion with `input` on stdin, collecting its output. */
function git(
  args: string[],
  env: NodeJS.ProcessEnv,
  input: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, signal });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr }),
    );
    // A Git that exits early closes its stdin; its exit code says why.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

type TreeEntry = {
  kind: 'file' | 'executable' | 'symlink';
  object: string;
  /** Path components below the target, each checked by `safeComponents`. */
  parts: string[];
};

/**
 * The components of a tree path, or an error for one that could leave the
 * target or write into a repository: Git refuses the same names on checkout.
 */
function safeComponents(name: string): string[] {
  const parts = name.split('/');
  if (
    name.startsWith('/') ||
    name.includes('\\') ||
    parts.some(
      (part) =>
        part === '' ||
        part === '.' ||
        part === '..' ||
        part.toLowerCase() === '.git',
    )
  ) {
    throw new CommitCheckoutError(
      `The commit has an unsafe path: ${name}`,
      false,
    );
  }
  return parts;
}

/** Parse `ls-tree -r -z` output: `<mode> <type> <object>\t<path>\0`. */
function parseTree(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let start = 0; start < output.length;) {
    let end = output.indexOf(0, start);
    if (end === -1) end = output.length;
    const record = output.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    const [mode, type, object] = record
      .subarray(0, tab)
      .toString('latin1')
      .split(' ');
    const name = record.subarray(tab + 1).toString('utf8');
    if (tab === -1 || !object || !name) {
      throw new CommitCheckoutError('Git listed an unreadable tree.', false);
    }
    if (mode === '160000' && type === 'commit') continue;
    const kind =
      mode === '100644' || mode === '100664'
        ? 'file'
        : mode === '100755'
          ? 'executable'
          : mode === '120000'
            ? 'symlink'
            : null;
    if (!kind || type !== 'blob') {
      throw new CommitCheckoutError(
        `The commit has an entry of unsupported mode ${mode}: ${name}`,
        false,
      );
    }
    entries.push({ kind, object, parts: safeComponents(name) });
  }
  return entries;
}

/** Sequential reads of a stream: header lines and exact byte counts. */
class StreamReader {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly chunks: AsyncIterator<Buffer>;

  constructor(stream: AsyncIterable<Buffer>) {
    this.chunks = stream[Symbol.asyncIterator]();
  }

  private async fill(): Promise<boolean> {
    const next = await this.chunks.next();
    if (next.done) return false;
    this.buffered = this.buffered.length
      ? Buffer.concat([this.buffered, next.value])
      : next.value;
    return true;
  }

  /** The next line without its LF, or null at the end of the stream. */
  async line(): Promise<string | null> {
    for (;;) {
      const end = this.buffered.indexOf(0x0a);
      if (end !== -1) {
        const line = this.buffered.subarray(0, end).toString('latin1');
        this.buffered = this.buffered.subarray(end + 1);
        return line;
      }
      if (!(await this.fill())) return null;
    }
  }

  /** Pass the next `size` bytes to `sink` in order; false if they end early. */
  async bytes(
    size: number,
    sink: (chunk: Buffer) => Promise<void>,
  ): Promise<boolean> {
    let left = size;
    while (left > 0) {
      if (!this.buffered.length && !(await this.fill())) return false;
      const chunk = this.buffered.subarray(0, left);
      this.buffered = this.buffered.subarray(chunk.length);
      left -= chunk.length;
      await sink(chunk);
    }
    return true;
  }
}

/**
 * Stream the contents of `entries`' blobs from one `cat-file --batch`,
 * calling `write` once per entry, in order, with the blob's chunks.
 */
async function readBlobs(
  args: string[],
  env: NodeJS.ProcessEnv,
  entries: TreeEntry[],
  write: (
    entry: TreeEntry,
    read: (sink: (chunk: Buffer) => Promise<void>) => Promise<void>,
  ) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const child: ChildProcessWithoutNullStreams = spawn(
    'git',
    [...args, 'cat-file', '--batch'],
    { env, signal },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  // Surfaced through `exited` and the reads below.
  exited.catch(() => {});
  child.stdin.on('error', () => {});
  child.stdin.end(entries.map((entry) => `${entry.object}\n`).join(''));
  // A reply that is not the blob asked for (`<object> missing`) names the
  // problem itself; output that stops early leaves Git's diagnostic.
  const failed = async (name: string, reply: string | null) => {
    if (reply === null) await exited;
    signal?.throwIfAborted();
    return new CommitCheckoutError(
      `Could not read ${name}: ${reply || stderr.trim() || 'Git stopped early.'}`,
      false,
    );
  };
  try {
    const reader = new StreamReader(child.stdout);
    for (const entry of entries) {
      const name = entry.parts.join('/');
      const header = await reader.line();
      const [object, type, size] = header?.split(' ') ?? [];
      if (
        object !== entry.object ||
        type !== 'blob' ||
        !/^\d+$/.test(size ?? '')
      ) {
        throw await failed(name, header);
      }
      let complete = false;
      await write(entry, async (sink) => {
        complete =
          (await reader.bytes(Number(size), sink)) &&
          (await reader.line()) === '';
      });
      if (!complete) throw await failed(name, null);
    }
    if ((await exited) !== 0) throw await failed('the commit', null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/** Remove `dir`; a failure is reported, never thrown over the outcome. */
async function removeOwned(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch((error) => {
    console.error(`[app-build] could not remove ${dir}:`, error);
  });
}

export async function checkoutCommit(options: {
  /** The repository (`--git-dir` of a bare one, or a work tree root). */
  repo: { gitDir: string } | { cwd: string };
  /** Full commit id. */
  commit: string;
  /** Directory to create; it must not exist yet. */
  target: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<void> {
  const { commit, signal } = options;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new CommitCheckoutError('Commit must be a full commit id.', false);
  }
  const args = [
    ...('gitDir' in options.repo
      ? ['--git-dir', options.repo.gitDir]
      : ['-C', options.repo.cwd]),
    // Replace refs would substitute other objects for the committed ones.
    '--no-replace-objects',
  ];
  const env = options.env ?? process.env;

  // Absence is established on its own: a store Git cannot read also answers
  // `missing`, with an `error:` on stderr, and is not a missing commit.
  const probe = await git(
    [...args, 'cat-file', '--batch-check'],
    env,
    `${commit}\n`,
    signal,
  );
  const answer = probe.stdout.toString('latin1').trim();
  if (
    probe.code === 0 &&
    !/^(?:error|fatal):/m.test(probe.stderr) &&
    answer === `${commit} missing`
  )
    throw new CommitCheckoutError(
      `Commit ${commit} is not in the repository.`,
      true,
    );
  if (probe.code !== 0 || !answer.startsWith(`${commit} commit `)) {
    throw new CommitCheckoutError(
      `Could not read commit ${commit}: ${probe.stderr.trim() || answer}`,
      false,
    );
  }

  const listed = await git(
    [...args, 'ls-tree', '-r', '-z', '--full-tree', commit],
    env,
    '',
    signal,
  );
  if (listed.code !== 0) {
    throw new CommitCheckoutError(
      `Could not read the tree of ${commit}: ${listed.stderr.trim()}`,
      false,
    );
  }
  const entries = parseTree(listed.stdout);

  const target = path.resolve(options.target);
  await fs.mkdir(target);
  try {
    // Every directory below `target` is one this checkout made, so no write
    // can pass through a link: links are written last, and `wx` and mkdir
    // never replace what exists (a repeated or case-folded name fails).
    const directories = new Set<string>([target]);
    const conflict = (parts: string[]) =>
      new CommitCheckoutError(
        `The commit has conflicting paths at ${parts.join('/')}.`,
        false,
      );
    const at = async (parts: string[]) => {
      let dir = target;
      for (const part of parts.slice(0, -1)) {
        dir = path.join(dir, part);
        if (directories.has(dir)) continue;
        await fs.mkdir(dir).catch((error: NodeJS.ErrnoException) => {
          throw error.code === 'EEXIST' ? conflict(parts) : error;
        });
        directories.add(dir);
      }
      return path.join(dir, parts.at(-1)!);
    };
    const files = entries.filter((entry) => entry.kind !== 'symlink');
    const links = entries.filter((entry) => entry.kind === 'symlink');
    await readBlobs(
      args,
      env,
      [...files, ...links],
      async (entry, read) => {
        const file = await at(entry.parts);
        if (entry.kind === 'symlink') {
          const chunks: Buffer[] = [];
          await read(async (chunk) => void chunks.push(chunk));
          await fs.symlink(Buffer.concat(chunks), file).catch((error) => {
            throw (error as NodeJS.ErrnoException).code === 'EEXIST'
              ? conflict(entry.parts)
              : error;
          });
          return;
        }
        const handle = await fs
          .open(file, 'wx', entry.kind === 'executable' ? 0o777 : 0o666)
          .catch((error: NodeJS.ErrnoException) => {
            throw error.code === 'EEXIST' ? conflict(entry.parts) : error;
          });
        try {
          await read(async (chunk) => {
            for (let done = 0; done < chunk.length;) {
              done += (await handle.write(chunk, done)).bytesWritten;
            }
          });
        } finally {
          await handle.close();
        }
      },
      signal,
    );
  } catch (error) {
    // The target is this checkout's own: a failure leaves nothing behind.
    await removeOwned(target);
    throw error;
  }
}
