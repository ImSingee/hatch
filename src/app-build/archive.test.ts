/**
 * Build packages arrive from builds the platform does not trust, so
 * unpacking one may only ever create regular files and directories below
 * its destination.
 */
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { packBuildDirectory, unpackBuildArchive } from './archive';

const root = await mkdtemp(path.join(os.tmpdir(), 'hatch-build-archive-'));
afterAll(() => rm(root, { recursive: true, force: true }));

let counter = 0;
const target = () => path.join(root, `out-${++counter}`);

/** One ustar entry with an arbitrary type flag and name. */
function entry(name: string, type: string, body = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write(
    `${body.length.toString(8).padStart(11, '0')}\0`,
    124,
    12,
    'ascii',
  );
  header.fill(' ', 148, 156);
  header.write(type, 156, 1, 'ascii');
  if (type === '2' || type === '1') header.write('/etc/passwd', 157, 100);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

const archive = (...entries: Buffer[]) =>
  gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)]));

describe('build archives', () => {
  it('round-trips files and directories, long paths included', async () => {
    const source = path.join(root, 'source');
    const deep = path.join(
      source,
      'app',
      'web',
      'a'.repeat(60),
      'b'.repeat(60),
    );
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(source, 'build.json'), '{"format":1}');
    await writeFile(path.join(deep, 'chunk.js'), 'export {};');
    await mkdir(path.join(source, 'backend', 'assets'), { recursive: true });
    const destination = target();
    expect(
      await unpackBuildArchive(await packBuildDirectory(source), destination),
    ).toBe(2);
    expect(await readFile(path.join(destination, 'build.json'), 'utf8')).toBe(
      '{"format":1}',
    );
    expect(
      await readFile(
        path.join(destination, path.relative(source, deep), 'chunk.js'),
        'utf8',
      ),
    ).toBe('export {};');
    expect(
      (await lstat(path.join(destination, 'backend', 'assets'))).isDirectory(),
    ).toBe(true);
  });

  it.each([
    ['a symbolic link', entry('app/link.js', '2')],
    ['a hard link', entry('app/link.js', '1')],
    ['a device', entry('app/null', '3')],
    ['a parent path', entry('../escape.js', '0', Buffer.from('x'))],
    [
      'a nested parent path',
      entry('app/../../escape.js', '0', Buffer.from('x')),
    ],
    ['an absolute path', entry('/tmp/escape.js', '0', Buffer.from('x'))],
  ])('rejects %s and writes nothing outside', async (_name, unsafe) => {
    const destination = target();
    await expect(
      unpackBuildArchive(archive(unsafe), destination),
    ).rejects.toThrow(/files and directories|unsafe path/);
    expect(await readdir(root)).not.toContain('escape.js');
    const written = await readdir(destination).catch(() => []);
    expect(written).toEqual([]);
  });

  it('never lets a later entry replace an earlier one', async () => {
    await expect(
      unpackBuildArchive(
        archive(
          entry('build.json', '0', Buffer.from('first')),
          entry('build.json', '0', Buffer.from('second')),
        ),
        target(),
      ),
    ).rejects.toThrow(/repeats/);
  });

  it('rejects data that is not a gzipped archive', async () => {
    await expect(
      unpackBuildArchive(Buffer.from('not gzip'), target()),
    ).rejects.toThrow(/not gzip/);
  });
});
