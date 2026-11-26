/**
 * Rules checked with NSH itself: the catalogue's types reject `class` and
 * `style`, forms keep drafts through the App's storage, tabs keep a selection
 * while their items change, list pages open any item, follow their items,
 * keep the detail and survive resizes, toast actions run, the library follows
 * the shell's theme, sections and stack pages keep the shell's route and
 * title, and the gallery builds for release with every class resolved.
 * Skipped where `nsh` is not installed (not on `PATH`, `~/.local/bin` or
 * `~/.nsh/bin`), except in CI, which installs the pinned release; set
 * `NSH_BIN` (or the platform's `HATCH_NSH_BIN`) to use another binary.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareAppRoot } from '../gallery/prepare.ts';

/** `NSH_BIN`, else `nsh` on `PATH` (an empty entry is the current
 * directory), else the install script's places. Absolute, because the tests
 * run it from each fixture's directory. */
const configured = process.env.NSH_BIN || process.env.HATCH_NSH_BIN;
const nsh = configured
  ? path.resolve(configured)
  : [
      ...(process.env.PATH ?? '')
        .split(path.delimiter)
        .map((directory) => path.resolve(directory || '.', 'nsh')),
      path.join(os.homedir(), '.local/bin/nsh'),
      path.join(os.homedir(), '.nsh/bin/nsh'),
    ].find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });

const UI = path.resolve(import.meta.dirname, '..');

/** Runs `nsh`: `ok` and its output when it succeeds, else `exit <status>`
 * and its output, so a failure shows what NSH said. */
function run(args: string[], cwd: string): string {
  const result = spawnSync(nsh as string, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return result.status === 0
    ? `ok\n${output}`
    : `exit ${result.status}\n${output}`;
}

/** Copies a fixture App into a temporary App root laid out like the
 * platform's. */
function fixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hatch-ui-${name}-`));
  fs.cpSync(path.join(UI, 'test/fixtures', name), root, { recursive: true });
  prepareAppRoot(root, { id: `dev.hatch.test.${name}`, name });
  return root;
}

// CI installs the pinned release: a missing one there is a failure.
if (!nsh && process.env.CI)
  throw new Error('nsh is not installed; CI must install the pinned NSH.');

describe.skipIf(!nsh)('with NSH', () => {
  it('rejects class and style on every component', () => {
    expect(run(['check', 'app/main.tsx'], fixture('rules'))).toMatch(/^ok\n/);
  }, 240_000);

  it('keeps form drafts in the App storage', () => {
    expect(run(['test', 'app/draft.test.tsx'], fixture('draft'))).toMatch(
      /^ok\n[\s\S]*20 passed/,
    );
  }, 240_000);

  it('keeps a tab selected while the items change', () => {
    expect(run(['test', 'app/tabs.test.tsx'], fixture('tabs'))).toMatch(
      /^ok\n[\s\S]*6 passed/,
    );
  }, 240_000);

  it('opens list items, follows their changes and keeps them across resizes', () => {
    expect(run(['test', 'app/patterns.test.tsx'], fixture('patterns'))).toMatch(
      /^ok\n[\s\S]*4 passed/,
    );
  }, 240_000);

  it('keeps a list page detail while its record is replaced', () => {
    expect(run(['test', 'app/records.test.tsx'], fixture('records'))).toMatch(
      /^ok\n[\s\S]*1 passed/,
    );
  }, 240_000);

  it('runs toast actions, never disabled ones', () => {
    expect(run(['test', 'app/toast.test.tsx'], fixture('toast'))).toMatch(
      /^ok\n[\s\S]*2 passed/,
    );
  }, 240_000);

  it('follows the shell theme, over the built-in one', () => {
    expect(run(['test', 'app/theme.test.tsx'], fixture('theme'))).toMatch(
      /^ok\n[\s\S]*2 passed/,
    );
  }, 240_000);

  it('keeps the route and title in the shell for sections and stack pages', () => {
    expect(run(['test', 'app/route.test.tsx'], fixture('route'))).toMatch(
      /^ok\n[\s\S]*5 passed/,
    );
  }, 240_000);

  it('builds the gallery for release with every class resolved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hatch-ui-gallery-'));
    fs.cpSync(path.join(UI, 'gallery/app'), path.join(root, 'app'), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.nsh`),
    });
    prepareAppRoot(root, { id: 'dev.hatch.test.gallery', name: 'Gallery' });
    expect(run(['check', 'app/main.tsx'], root)).toMatch(/^ok\n/);
    const build = run(['build', 'app/main.tsx', '--release'], root);
    expect(build).toMatch(/^ok\n/);
    expect(build).not.toMatch(/unknown class/);
  }, 240_000);
});
