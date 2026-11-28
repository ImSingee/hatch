/**
 * Checks the vendored NSH macOS backend (`desktop/src-tauri/vendor/
 * nsh-platform-macos`) against the published crate and the upstream fix it
 * carries: every file of `nsh-platform-macos` 0.7.0 from crates.io, with the
 * archive's SHA-256 checked, is byte for byte the same in the vendored copy,
 * except `src/app.rs`, whose change from 0.7.0 must be exactly the change
 * upstream commit a63b867 (longbridge/nsh#3528) made to that file: the same
 * `diff -u` hunks, context and line numbers included. The copy holds nothing
 * else but `HATCH-VENDOR.md` and the license. Run with
 * `pnpm nsh:vendor:check` (needs network, `tar` and `diff`).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE = 'nsh-platform-macos';
const VERSION = '0.7.0';
const CRATE_SHA256 =
  '2b91b4ec02d9eec10020d6610344b6c6ac04c039a3e9711581a063fd248ca1c1';
const CRATE_URL = `https://static.crates.io/crates/${CRATE}/${CRATE}-${VERSION}.crate`;

/** The only changed file, and the upstream commit whose change it carries. */
const CHANGED_FILE = 'src/app.rs';
const UPSTREAM_COMMIT = 'a63b8670bc60864125c8992667ab5eef205d76b2';
const UPSTREAM_PARENT = 'caa818b9801f79947b4633437f61af4b2dc2b0cc';
const UPSTREAM_PATH = 'crates/nsh-platform-macos/src/app.rs';
/** SHA-256 of the upstream file before and after the commit. */
const UPSTREAM_BEFORE_SHA256 =
  'c8a4c8cd3207f8bb798d2cb05e6e0e6930d17759b135986138e3798300ecb24d';
const UPSTREAM_AFTER_SHA256 =
  'fdecf52caa6ad1fd826c68b016963e7f6111ffe7d3fa705a68eab1210d2d6cd4';

/** Files the vendored copy adds to the crate. */
const ADDED = new Set(['HATCH-VENDOR.md', 'LICENSE-APACHE']);

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const vendored = path.join(root, 'desktop/src-tauri/vendor', CRATE);

function sha256(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

async function download(url: string, expectedSha256: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const sha = sha256(data);
  if (sha !== expectedSha256) {
    throw new Error(`${url} has SHA-256 ${sha}, expected ${expectedSha256}`);
  }
  return data;
}

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(full, base)
      : [path.relative(base, full).split(path.sep).join('/')];
  });
}

/** `diff -u` of two files without the two lines that name them. */
function hunks(from: string, to: string) {
  let output: string;
  try {
    output = execFileSync('diff', ['-u', from, to], { encoding: 'utf8' });
  } catch (error) {
    // `diff` exits 1 when the files differ.
    const failure = error as { status?: number; stdout?: string };
    if (failure.status !== 1 || failure.stdout === undefined) throw error;
    output = failure.stdout;
  }
  return output.split('\n').slice(2).join('\n');
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-vendor-'));
  try {
    const archive = path.join(work, 'crate.tar.gz');
    fs.writeFileSync(archive, await download(CRATE_URL, CRATE_SHA256));
    execFileSync('tar', ['-xzf', archive, '-C', work]);
    const original = path.join(work, `${CRATE}-${VERSION}`);

    const raw = (commit: string) =>
      `https://raw.githubusercontent.com/longbridge/nsh/${commit}/${UPSTREAM_PATH}`;
    const before = path.join(work, 'upstream-before.rs');
    const after = path.join(work, 'upstream-after.rs');
    fs.writeFileSync(
      before,
      await download(raw(UPSTREAM_PARENT), UPSTREAM_BEFORE_SHA256),
    );
    fs.writeFileSync(
      after,
      await download(raw(UPSTREAM_COMMIT), UPSTREAM_AFTER_SHA256),
    );

    const problems: string[] = [];
    const originalFiles = listFiles(original);
    const vendoredFiles = new Set(listFiles(vendored));
    for (const name of originalFiles) {
      if (!vendoredFiles.has(name)) {
        problems.push(`missing: ${name}`);
        continue;
      }
      vendoredFiles.delete(name);
      const ours = path.join(vendored, name);
      const theirs = path.join(original, name);
      if (name === CHANGED_FILE) {
        const change = hunks(theirs, ours);
        if (change !== hunks(before, after)) {
          problems.push(
            `${name}: the change from ${VERSION} is not upstream ${UPSTREAM_COMMIT.slice(0, 7)}'s:\n${change}`,
          );
        }
      } else if (!fs.readFileSync(theirs).equals(fs.readFileSync(ours))) {
        problems.push(`differs: ${name}`);
      }
    }
    for (const name of vendoredFiles) {
      if (!ADDED.has(name)) problems.push(`not in the crate: ${name}`);
    }
    for (const name of ADDED) {
      if (!fs.existsSync(path.join(vendored, name))) {
        problems.push(`missing: ${name}`);
      }
    }
    if (problems.length) {
      throw new Error(
        `The vendored ${CRATE} is not ${VERSION} plus upstream ${UPSTREAM_COMMIT.slice(0, 7)}:\n  ${problems.join('\n  ')}`,
      );
    }
    console.log(
      `${CRATE} ${VERSION}: ${originalFiles.length - 1} files match the crate (SHA-256 ${CRATE_SHA256.slice(0, 12)}…); ${CHANGED_FILE} carries exactly upstream ${UPSTREAM_COMMIT.slice(0, 7)}'s change.`,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
