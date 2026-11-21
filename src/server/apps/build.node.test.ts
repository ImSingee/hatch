/** App builds of pnpm-lockfile sources: no Deno build command, Deno runtime. */
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './build';

const execFileAsync = promisify(execFile);
const templateDir = path.resolve('templates/default-app');
const tempDirs: string[] = [];

/** The runtime flags of a `bundle-v1` backend artifact. */
function bundleRuntimeFlags(outputDir: string): string[] {
  return [
    '--no-config',
    '--no-lock',
    '--no-npm',
    '--no-remote',
    '--cached-only',
    `--allow-read=${path.join(outputDir, 'backend', 'assets')}`,
    '--allow-net',
    '--allow-env',
    '--no-prompt',
  ];
}

async function workspace(): Promise<{ sourceDir: string; outputDir: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-node-build-'));
  tempDirs.push(root);
  return {
    sourceDir: path.join(root, 'src'),
    outputDir: path.join(root, 'out'),
  };
}

/** The default template as `create_app` scaffolds it, with the id `demo`. */
async function templateSource() {
  const dirs = await workspace();
  await fs.cp(templateDir, dirs.sourceDir, { recursive: true });
  const manifest = path.join(dirs.sourceDir, 'manifest.ts');
  await fs.writeFile(
    manifest,
    (await fs.readFile(manifest, 'utf8'))
      .replaceAll('__APP_ID__', JSON.stringify('demo'))
      .replaceAll('__APP_NAME__', JSON.stringify('Demo'))
      .replaceAll('__APP_DESCRIPTION__', JSON.stringify('Demo app')),
  );
  return dirs;
}

/** A source with the template's dependency files and the given files. */
async function source(files: Record<string, string>) {
  const dirs = await workspace();
  await fs.mkdir(dirs.sourceDir, { recursive: true });
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    await fs.copyFile(
      path.join(templateDir, file),
      path.join(dirs.sourceDir, file),
    );
  }
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dirs.sourceDir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, 'utf8');
  }
  return dirs;
}

function manifestSource(fields: string, prelude = ''): string {
  return (
    "import { defineAppManifest } from '@hatch/app';\n" +
    prelude +
    'export default defineAppManifest({\n' +
    "  id: 'demo',\n  name: 'Demo',\n  compatibilityVersion: 2,\n" +
    fields +
    '});\n'
  );
}

async function listFiles(root: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const files = await Promise.all(
    entries.map((entry) => {
      const child = path.posix.join(relative, entry.name);
      return entry.isDirectory() ? listFiles(root, child) : [child];
    }),
  );
  return files.flat().sort();
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('buildApp with the Node toolchain', { timeout: 180_000 }, () => {
  it('builds the default template into a self-contained artifact that Deno serves', async () => {
    const { sourceDir, outputDir } = await templateSource();
    // pnpm writes this file into worktrees; a deploy must never act on it.
    await fs.writeFile(
      path.join(sourceDir, 'pnpm-workspace.yaml'),
      'registry: http://127.0.0.1:1/\ndangerouslyAllowAllBuilds: true\n',
    );

    const result = await buildApp('demo', { sourceDir, outputDir });

    // The toolchain is pnpm, tsc, esbuild and Node; Deno builds nothing.
    expect(result.log).not.toMatch(/^\$ deno /m);
    expect(result.log).toContain('$ pnpm fetch --ignore-workspace');
    expect(result.log).toContain(
      '--offline --frozen-lockfile --ignore-scripts --no-runtime --trust-lockfile',
    );
    expect(result.log).toContain('$ tsc -p .hatch/tsconfig.check.json');
    expect(result.log).toContain('$ node --permission --input-type=module -');

    // The runtime contract is unchanged: a bundle-v1 deno-serve backend.
    expect(result.normalized.backend).toEqual({
      entry: 'backend/main.bundle.js',
      runtime: 'deno-serve',
      network: [],
      format: 'bundle-v1',
    });
    expect(Object.keys(result.dataSchema?.tables ?? {})).toEqual(['counters']);
    expect(await listFiles(outputDir)).toEqual([
      'app/app.js',
      'app/index.html',
      'backend/main.bundle.js',
      'manifest.normalized.json',
      'widgets/counter.js',
    ]);

    const port = await freePort();
    const server = spawn(
      'deno',
      [
        'serve',
        '--host=127.0.0.1',
        `--port=${port}`,
        ...bundleRuntimeFlags(outputDir),
        'backend/main.bundle.js',
      ],
      { cwd: outputDir, stdio: 'ignore' },
    );
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 100 && !response; attempt++) {
        response = await fetch(`http://127.0.0.1:${port}/missing`).catch(
          () => undefined,
        );
        if (!response) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // The template's own fetch handler answered.
      expect(response?.status).toBe(404);
      expect(await response?.text()).toBe('Not found');
    } finally {
      server.kill('SIGKILL');
    }
  });

  it('bundles a deno-run backend that runs under the bundle-v1 flags', async () => {
    const { sourceDir, outputDir } = await source({
      'manifest.ts': manifestSource(
        '  capabilities: { backend: true },\n' +
          "  backend: { entry: 'backend/main.ts', runtime: 'deno-run', network: [] },\n",
      ),
      'backend/main.ts':
        "import { createConnectRouter } from '@connectrpc/connect';\n" +
        "console.log(`handlers=${createConnectRouter({}).handlers.length} port=${Deno.env.get('PORT')}`);\n",
    });

    const result = await buildApp('demo', { sourceDir, outputDir });

    expect(result.log).not.toMatch(/^\$ deno /m);
    expect(result.normalized.backend).toMatchObject({
      runtime: 'deno-run',
      format: 'bundle-v1',
    });
    const executed = await execFileAsync(
      'deno',
      ['run', ...bundleRuntimeFlags(outputDir), 'backend/main.bundle.js'],
      { cwd: outputDir, env: { ...process.env, PORT: '4321' } },
    );
    expect(executed.stdout.trim()).toBe('handlers=0 port=4321');
  });

  it('evaluates manifest.ts without file, process, worker or network access', async () => {
    const marker = path.join(os.tmpdir(), `hatch-eval-${process.pid}.marker`);
    const { sourceDir, outputDir } = await source({
      'manifest.ts': manifestSource(
        '  description: attempts.join(),\n  capabilities: {},\n',
        // Built-ins are reachable without an import; only the permission
        // model stands between evaluated source and the host.
        'const node = (globalThis as any).process;\n' +
          'const attempts: string[] = [];\n' +
          'const attempt = (name: string, run: () => unknown) => {\n' +
          '  try { run(); attempts.push(`${name}:allowed`); } catch { attempts.push(`${name}:denied`); }\n' +
          '};\n' +
          "attempt('read', () => node.getBuiltinModule('node:fs').readFileSync(node.execPath));\n" +
          `attempt('write', () => node.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'));\n` +
          "attempt('spawn', () => node.getBuiltinModule('node:child_process').execFileSync(node.execPath, ['-v']));\n" +
          "attempt('worker', () => new (node.getBuiltinModule('node:worker_threads').Worker)('1', { eval: true }));\n" +
          'attempts.push(await new Promise<string>((resolve) => {\n' +
          '  try {\n' +
          "    const socket = node.getBuiltinModule('node:net').connect(9, '127.0.0.1');\n" +
          "    socket.once('connect', () => resolve('connect:allowed'));\n" +
          "    socket.once('error', (error: { code?: string }) => resolve(error.code === 'ERR_ACCESS_DENIED' ? 'connect:denied' : 'connect:allowed'));\n" +
          "  } catch { resolve('connect:denied'); }\n" +
          '}));\n',
      ),
    });

    const result = await buildApp('demo', { sourceDir, outputDir });

    // Node denies network to a permission-restricted process only from the
    // version that has an --allow-net flag to withhold.
    const network = process.allowedNodeEnvironmentFlags.has('--allow-net')
      ? 'denied'
      : 'allowed';
    expect(result.source.description).toBe(
      `read:denied,write:denied,spawn:denied,worker:denied,connect:${network}`,
    );
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a browser bundle that keeps a remote import', async () => {
    const { sourceDir, outputDir } = await source({
      'manifest.ts': manifestSource(
        '  capabilities: { frontend: true },\n' +
          "  app: { entry: 'app/main.ts', html: 'app/index.html' },\n",
      ),
      'app/index.html': '<body><script src="./app.js"></script></body>',
      // An ambient declaration satisfies the type checker, and esbuild keeps
      // URL imports external; the bundle itself has to be checked.
      'app/remote.d.ts':
        "declare module 'https://example.com/*' {\n  const value: number;\n  export default value;\n}\n",
      'app/main.ts':
        '/// <reference path="./remote.d.ts" />\n' +
        "import value from 'https://example.com/mod.js';\n" +
        'document.title = String(value);\n',
    });

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /App bundle must not contain external imports: "https:\/\/example\.com\/mod\.js"/,
    );
  });

  it('rejects a source that keeps Deno dependency files beside pnpm-lock.yaml', async () => {
    const { sourceDir, outputDir } = await source({
      'manifest.ts': manifestSource('  capabilities: {},\n'),
      'deno.json': '{}',
    });

    await expect(buildApp('demo', { sourceDir, outputDir })).rejects.toThrow(
      /mixes two build toolchains.*Remove deno\.json to build with pnpm/s,
    );
  });
});
