/**
 * A build replaces the requested output only once it has fully succeeded:
 * a failure in a step after source validation (here the frontend bundle)
 * leaves a direct caller's previous output in place.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failBundles = { on: false };

vi.mock('esbuild', async (importOriginal) => {
  const real = await importOriginal<typeof import('esbuild')>();
  return {
    ...real,
    // Fail only the frontend bundle, which runs after source validation.
    build: ((options: Parameters<typeof real.build>[0]) =>
      failBundles.on && options.outfile?.endsWith(path.join('app', 'app.js'))
        ? Promise.reject(new Error('frontend bundle failed'))
        : real.build(options)) as typeof real.build,
  };
});

const { buildApp } = await import('./build');

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

    failBundles.on = true;
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
  }, 60_000);
});
