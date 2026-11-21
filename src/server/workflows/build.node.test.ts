/** Workflow builds of pnpm-lockfile sources: no Deno build command. */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkflow } from './build';
import { buildWorkflowDenoArgs } from './runtime-permissions';

const tempDirs: string[] = [];

/** The default template as `create_workflow` scaffolds it, with the id `demo`. */
async function templateSource() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hatch-node-workflow-'));
  tempDirs.push(root);
  const sourceDir = path.join(root, 'src');
  await fs.cp(path.resolve('templates/default-workflow'), sourceDir, {
    recursive: true,
  });
  const manifest = path.join(sourceDir, 'manifest.ts');
  await fs.writeFile(
    manifest,
    (await fs.readFile(manifest, 'utf8'))
      .replace('__WORKFLOW_ID__', JSON.stringify('demo'))
      .replace('__WORKFLOW_NAME__', JSON.stringify('Demo'))
      .replace('__WORKFLOW_DESCRIPTION__', JSON.stringify('Demo workflow')),
  );
  return { sourceDir, outputDir: path.join(root, 'out') };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('buildWorkflow with the Node toolchain', { timeout: 120_000 }, () => {
  it('builds the default template into a single program that runs on Deno', async () => {
    const { sourceDir, outputDir } = await templateSource();

    const result = await buildWorkflow('demo', { sourceDir, outputDir });

    // Install, checks, manifest evaluation and bundling leave Deno out. The
    // one Deno process of a build is describe mode, which runs the artifact
    // itself on its runtime and is not logged.
    expect(result.log).not.toMatch(/^\$ deno /m);
    expect(result.log).toContain('$ pnpm fetch --ignore-workspace');
    expect(result.log).toContain('$ tsc -p .hatch/tsconfig.check.json');
    expect(result.log).toContain('$ node --permission --input-type=module -');
    expect(result.inputSchema).toMatchObject({
      properties: { name: { type: 'string' }, times: { default: 1 } },
    });
    expect((await fs.readdir(outputDir)).sort()).toEqual([
      'input.schema.json',
      'manifest.normalized.json',
      'workflow.js',
    ]);

    // The artifact runs with the same explicit-network flags as every run.
    const child = execFile(
      'deno',
      buildWorkflowDenoArgs({
        bundlePath: result.bundlePath,
        artifactDir: outputDir,
        network: [],
      }),
      {
        cwd: outputDir,
        env: { PATH: process.env.PATH, HATCH_MODE: 'run', HATCH_RUN_ID: 'r1' },
      },
    );
    let stdout = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stdin?.end(`${JSON.stringify({ name: 'Ada', times: 2 })}\n`);
    const code = await new Promise((resolve) => child.once('close', resolve));
    expect(code).toBe(0);
    const end = stdout
      .split('\n')
      .filter((line) => line.startsWith('[[hatch]]'))
      .map((line) => JSON.parse(line.slice('[[hatch]]'.length)))
      .find((event) => event.t === 'run:end');
    expect(end).toMatchObject({
      status: 'succeeded',
      output: { greeting: 'Hello, Ada!\nHello, Ada!', count: 2 },
    });
  });

  it('rejects a source that keeps deno.lock beside pnpm-lock.yaml', async () => {
    const { sourceDir, outputDir } = await templateSource();
    await fs.writeFile(path.join(sourceDir, 'deno.lock'), '{}');

    await expect(
      buildWorkflow('demo', { sourceDir, outputDir }),
    ).rejects.toThrow(/Remove deno\.lock to build with pnpm/);
  });
});
