/**
 * Checks the vendored NSH macOS backend (`desktop/src-tauri/vendor/
 * nsh-platform-macos`) against the published crate: every file of
 * `nsh-platform-macos` 0.7.0 from crates.io, with the archive's SHA-256
 * checked, is byte for byte the same in the vendored copy, except the one
 * line `HATCH-VENDOR.md` names; the copy holds nothing else but that note
 * and the license. Run with `pnpm nsh:vendor:check` (needs network, `tar`).
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
/** The only change: `AppView::load` gives engines the inline-root context. */
const CHANGED_FILE = 'src/app.rs';
const ORIGINAL_LINE = '            context: Default::default(),';
const PATCHED_LINE =
  '            context: nsh_engine::with_inline_root(Default::default()), // Hatch: embedded JS roots draw in this view (see HATCH-VENDOR.md).';
/** Files the vendored copy adds to the crate. */
const ADDED = new Set(['HATCH-VENDOR.md', 'LICENSE-APACHE']);

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const vendored = path.join(root, 'desktop/src-tauri/vendor', CRATE);

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(full, base)
      : [path.relative(base, full).split(path.sep).join('/')];
  });
}

async function main() {
  const response = await fetch(CRATE_URL);
  if (!response.ok) throw new Error(`${CRATE_URL}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const sha = createHash('sha256').update(archive).digest('hex');
  if (sha !== CRATE_SHA256) {
    throw new Error(
      `${CRATE_URL} has SHA-256 ${sha}, expected ${CRATE_SHA256}`,
    );
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-vendor-'));
  try {
    const file = path.join(work, 'crate.tar.gz');
    fs.writeFileSync(file, archive);
    execFileSync('tar', ['-xzf', file, '-C', work]);
    const original = path.join(work, `${CRATE}-${VERSION}`);
    const problems: string[] = [];
    const originalFiles = listFiles(original);
    const vendoredFiles = new Set(listFiles(vendored));
    for (const name of originalFiles) {
      if (!vendoredFiles.has(name)) {
        problems.push(`missing: ${name}`);
        continue;
      }
      vendoredFiles.delete(name);
      let expected = fs.readFileSync(path.join(original, name));
      if (name === CHANGED_FILE) {
        const lines = expected.toString('utf8').split('\n');
        const at = lines.flatMap((line, index) =>
          line === ORIGINAL_LINE ? [index] : [],
        );
        if (at.length !== 1) {
          problems.push(`${name}: the original line is not there exactly once`);
          continue;
        }
        lines[at[0]] = PATCHED_LINE;
        expected = Buffer.from(lines.join('\n'), 'utf8');
      }
      if (!expected.equals(fs.readFileSync(path.join(vendored, name)))) {
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
        `The vendored ${CRATE} is not ${VERSION} plus the documented line:\n  ${problems.join('\n  ')}`,
      );
    }
    console.log(
      `${CRATE} ${VERSION}: ${originalFiles.length} files match the crate (SHA-256 ${CRATE_SHA256.slice(0, 12)}…), one documented line changed.`,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
