/**
 * The transport of a build package: a gzipped POSIX ustar archive of regular
 * files and directories. Readers reject every other entry type (links,
 * devices), unsafe names and archives over the package limits, so unpacking
 * an untrusted upload can only create files below its destination.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  BUILD_PACKAGE_MAX_COMPRESSED_BYTES,
  BUILD_PACKAGE_MAX_ENTRIES,
  BUILD_PACKAGE_MAX_EXPANDED_BYTES,
  BUILD_PACKAGE_MAX_FILES,
} from './format';

const BLOCK = 512;

export class BuildArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildArchiveError';
  }
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** Split a name over ustar's 100-byte name and 155-byte prefix fields. */
function splitName(name: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { name, prefix: '' };
  for (let index = name.indexOf('/'); index !== -1;) {
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { name: rest, prefix };
    }
    index = name.indexOf('/', index + 1);
  }
  throw new BuildArchiveError(`Path is too long for the archive: ${name}`);
}

function header(name: string, size: number, directory: boolean): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const split = splitName(directory ? `${name}/` : name);
  block.write(split.name, 0, 100, 'utf8');
  block.write(octal(directory ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(size, 12), 124, 12, 'ascii');
  block.write(octal(0, 12), 136, 12, 'ascii');
  block.fill(' ', 148, 156);
  block.write(directory ? '5' : '0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(split.prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** Pack the files and directories below `root` (no links) into a .tar.gz. */
export async function packBuildDirectory(root: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let files = 0;
  let directories = 0;
  let bytes = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        directories += 1;
        if (files + directories > BUILD_PACKAGE_MAX_ENTRIES) {
          throw new BuildArchiveError('The build package is too large.');
        }
        parts.push(header(child, 0, true));
        await walk(child);
      } else if (entry.isFile()) {
        files += 1;
        const remaining = BUILD_PACKAGE_MAX_EXPANDED_BYTES - bytes;
        if (files > BUILD_PACKAGE_MAX_FILES) {
          throw new BuildArchiveError('The build package is too large.');
        }
        const body = await readAtMost(path.join(root, child), remaining);
        bytes += body.length;
        parts.push(header(child, body.length, false), body);
        const padding = (BLOCK - (body.length % BLOCK)) % BLOCK;
        if (padding) parts.push(Buffer.alloc(padding, 0));
      } else {
        throw new BuildArchiveError(
          `The build package may contain only files and directories: ${child}`,
        );
      }
    }
  }
  await walk('');
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  const archive = gzipSync(Buffer.concat(parts), { level: 6 });
  if (archive.length > BUILD_PACKAGE_MAX_COMPRESSED_BYTES) {
    throw new BuildArchiveError('The build package is too large.');
  }
  return archive;
}

/**
 * Read a file of at most `limit` bytes. The buffer is the file's own size
 * (checked against the limit before reading), plus one byte that catches a
 * file growing while it is read, which is refused.
 */
async function readAtMost(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size > limit) {
      throw new BuildArchiveError('The build package is too large.');
    }
    const body = Buffer.alloc(size + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        body,
        read,
        body.length - read,
        null,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > size) {
        throw new BuildArchiveError(
          `A file changed while the build package was packed: ${path.basename(file)}`,
        );
      }
    }
    return body.subarray(0, read);
  } finally {
    await handle.close();
  }
}

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new BuildArchiveError('The build archive is corrupt.');
  }
  return text ? Number.parseInt(text, 8) : 0;
}

/** A relative, normalized name with no traversal, or an error. */
function safeName(raw: string): string {
  const name = raw.replace(/\/+$/, '');
  const normalized = path.posix.normalize(name);
  if (
    !name ||
    normalized !== name ||
    name.startsWith('/') ||
    name === '..' ||
    name.startsWith('../') ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((part) => part === '.' || part === '..' || !part)
  ) {
    throw new BuildArchiveError(`The build archive has an unsafe path: ${raw}`);
  }
  return name;
}

/**
 * Unpack a build archive into `destination`, which must not exist yet.
 * Returns the number of files written.
 */
export async function unpackBuildArchive(
  archive: Uint8Array,
  destination: string,
): Promise<number> {
  if (archive.length > BUILD_PACKAGE_MAX_COMPRESSED_BYTES) {
    throw new BuildArchiveError('The build package is too large.');
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, {
      // Headers and padding add to the expanded file bytes.
      maxOutputLength:
        BUILD_PACKAGE_MAX_EXPANDED_BYTES + BUILD_PACKAGE_MAX_FILES * BLOCK * 3,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new BuildArchiveError('The build package is too large.');
    }
    throw new BuildArchiveError('The build archive is not gzip data.');
  }

  await fs.mkdir(destination, { recursive: false });
  const seen = new Set<string>();
  // Every directory the archive creates, named or implied by a file's path,
  // counts toward the entry limit with the files: an archive of nothing but
  // directories must not exhaust the filesystem's inodes either.
  const directories = new Set<string>();
  const addDirectories = (relative: string) => {
    for (
      let dir = relative;
      dir && dir !== '.';
      dir = path.posix.dirname(dir)
    ) {
      if (directories.has(dir)) break;
      directories.add(dir);
    }
    if (files + directories.size > BUILD_PACKAGE_MAX_ENTRIES) {
      throw new BuildArchiveError('The build package is too large.');
    }
  };
  let files = 0;
  let bytes = 0;
  let offset = 0;
  let terminated = false;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    if (sum !== readOctal(block, 148, 8)) {
      throw new BuildArchiveError('The build archive is corrupt.');
    }
    const prefix = readString(block, 345, 155);
    const rawName = readString(block, 0, 100);
    const name = safeName(prefix ? `${prefix}/${rawName}` : rawName);
    const size = readOctal(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    offset += BLOCK;
    if (seen.has(name)) {
      throw new BuildArchiveError(`The build archive repeats ${name}.`);
    }
    seen.add(name);
    const target = path.join(destination, ...name.split('/'));
    if (type === '5') {
      addDirectories(name);
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    if (type !== '0') {
      throw new BuildArchiveError(
        `The build archive may contain only files and directories: ${name}`,
      );
    }
    files += 1;
    bytes += size;
    if (
      files > BUILD_PACKAGE_MAX_FILES ||
      bytes > BUILD_PACKAGE_MAX_EXPANDED_BYTES
    ) {
      throw new BuildArchiveError('The build package is too large.');
    }
    addDirectories(path.posix.dirname(name));
    // The body and its padding to the next block must all be there.
    if (offset + Math.ceil(size / BLOCK) * BLOCK > tar.length) {
      throw new BuildArchiveError('The build archive is truncated.');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // `wx`: a name already written (or a directory) is never replaced.
    await fs.writeFile(target, tar.subarray(offset, offset + size), {
      flag: 'wx',
    });
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }
  // A complete archive ends with its zero-block terminator.
  if (!terminated) {
    throw new BuildArchiveError('The build archive is truncated.');
  }
  return files;
}
