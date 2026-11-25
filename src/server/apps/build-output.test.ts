/**
 * A build replaces the requested output only once it has fully succeeded:
 * a failure in a step after source validation (here the frontend bundle)
 * leaves a direct caller's previous output in place.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failBundles: { on: false | 'source' | 'system' } = { on: false };

vi.mock('esbuild', async (importOriginal) => {
  const real = await importOriginal<typeof import('esbuild')>();
  return {
    ...real,
    // Fail only the frontend bundle, which runs after source validation.
    build: ((options: Parameters<typeof real.build>[0]) => {
      if (
        !failBundles.on ||
        !options.outfile?.endsWith(path.join('app', 'app.js'))
      ) {
        return real.build(options);
      }
      if (failBundles.on === 'system') {
        return Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC',
            errno: -28,
            syscall: 'write',
          }),
        );
      }
      return Promise.reject(new Error('frontend bundle failed'));
    }) as typeof real.build,
  };
});

const { AppBuildError, buildApp, replaceDirectory } = await import('./build');

const tempDirs: string[] = [];

afterEach(async () => {
  failBundles.on = false;
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('buildApp output replacement', () => {
  it('keeps the previous output when a later build step fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-build-out-'));
    tempDirs.push(root);
    const sourceDir = path.join(root, 'src');
    const outputDir = path.join(root, 'out');
    const files: Record<string, string> = {
      'manifest.json': JSON.stringify({
        id: 'demo',
        name: 'Demo',
        capabilities: { frontend: true },
        app: { entry: 'app/main.ts' },
      }),
      'package.json': JSON.stringify({ private: true, type: 'module' }),
      'deno.json': JSON.stringify({
        nodeModulesDir: 'auto',
        compilerOptions: {
          strict: true,
          jsx: 'react-jsx',
          jsxImportSource: 'react',
          lib: [
            'deno.ns',
            'dom',
            'dom.iterable',
            'dom.asynciterable',
            'esnext',
          ],
        },
        allowScripts: [],
      }),
      'deno.lock': JSON.stringify({
        version: '5',
        specifiers: {},
        npm: {},
        workspace: { packageJson: { dependencies: [] } },
      }),
      'app/main.ts': "document.title = 'Demo';\n",
      'app/index.html':
        '<!doctype html><html><head><title>Demo</title></head><body></body></html>\n',
    };
    for (const [file, contents] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(sourceDir, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(sourceDir, file), contents, 'utf8');
    }

    await buildApp('demo', { sourceDir, outputDir });
    const before = await fs.readFile(
      path.join(outputDir, 'manifest.normalized.json'),
      'utf8',
    );
    await fs.access(path.join(outputDir, 'app', 'app.js'));

    failBundles.on = 'source';
    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /frontend bundle failed/,
    );
    expect(
      await fs.readFile(
        path.join(outputDir, 'manifest.normalized.json'),
        'utf8',
      ),
    ).toBe(before);
    await fs.access(path.join(outputDir, 'app', 'app.js'));

    // A failed system call is not a source error: it stays internal.
    failBundles.on = 'system';
    const failure = await buildApp('demo', { sourceDir, outputDir }).catch(
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(AppBuildError);
    expect((failure as NodeJS.ErrnoException).code).toBe('ENOSPC');
  }, 60_000);

  it('keeps the previous output when copying across devices fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-build-swap-'));
    tempDirs.push(root);
    const staged = path.join(root, 'staged');
    const target = path.join(root, 'out');
    await fs.mkdir(staged);
    await fs.writeFile(path.join(staged, 'new.txt'), 'new');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'old.txt'), 'old');
    const crossDevice = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    await expect(
      replaceDirectory(staged, target, {
        mkdir: fs.mkdir,
        rm: fs.rm,
        rename: async (from, to) => {
          if (String(from) === staged) throw crossDevice;
          return fs.rename(from, to);
        },
        // Writes part of the copy, then fails.
        cp: async (_from, to) => {
          await fs.mkdir(String(to), { recursive: true });
          await fs.writeFile(path.join(String(to), 'partial.txt'), 'x');
          throw new Error('copy failed');
        },
      } as Parameters<typeof replaceDirectory>[2]),
    ).rejects.toThrow('copy failed');
    expect(await fs.readdir(target)).toEqual(['old.txt']);
    expect((await fs.readdir(root)).sort()).toEqual(['out', 'staged']);
  });
});
