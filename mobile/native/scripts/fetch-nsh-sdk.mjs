#!/usr/bin/env node
/**
 * Fetches the NSH embedding SDKs that `nsh-sdk.json` pins (release URL and
 * SHA-256 per platform) and unpacks what the native runtime links:
 *
 * - iOS: `ios/vendor/NativeShell.xcframework`
 * - Android: `android/vendor/maven/com/longbridge/nsh/nsh/<version>/` (the
 *   release `nsh.aar` as a local Maven artifact: an Android library may not
 *   depend on a local `.aar` file)
 *
 * Archives are cached in `~/.cache/hatch/nsh-sdk` (or `$HATCH_NSH_SDK_CACHE`)
 * and checked against the pin before use; a mismatch fails without unpacking.
 * A platform whose unpacked SDK already matches the pin is left alone.
 *
 * Usage: node fetch-nsh-sdk.mjs [ios|android|all]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(readFileSync(join(root, 'nsh-sdk.json'), 'utf8'));

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function archive(platform) {
  const { url, sha256: expected } = pin[platform];
  const cache = join(
    process.env.HATCH_NSH_SDK_CACHE ?? join(homedir(), '.cache/hatch/nsh-sdk'),
    pin.version,
  );
  mkdirSync(cache, { recursive: true });
  const file = join(cache, `nsh-embed-${platform}.zip`);
  if (existsSync(file) && (await sha256(file)) === expected) return file;
  const partial = `${file}.${process.pid}.partial`;
  process.stderr.write(`Downloading ${url}\n`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download of ${url} failed with HTTP ${response.status}.`);
  }
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256(partial);
  if (actual !== expected) {
    rmSync(partial, { force: true });
    throw new Error(
      `${url} has SHA-256 ${actual}; nsh-sdk.json pins ${expected}.`,
    );
  }
  renameSync(partial, file);
  return file;
}

/** Unpacks into a temporary directory next to `target`, then swaps it in. */
function unpack(zip, target, place) {
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, '.unpack-'));
  try {
    execFileSync('unzip', ['-q', zip, '-d', scratch]);
    const staged = join(scratch, 'staged');
    place(scratch, staged);
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const stampOf = (platform) => `${pin.version} ${pin[platform].sha256}\n`;

function current(target, platform) {
  const stamp = join(target, '.nsh-sdk');
  return existsSync(stamp) && readFileSync(stamp, 'utf8') === stampOf(platform);
}

async function fetchIos() {
  const target = join(root, 'ios/vendor');
  if (current(target, 'ios')) return;
  const zip = await archive('ios');
  unpack(zip, target, (scratch, staged) => {
    mkdirSync(staged);
    renameSync(
      join(scratch, 'nsh-embed-ios/NativeShell.xcframework'),
      join(staged, 'NativeShell.xcframework'),
    );
    writeFileSync(join(staged, '.nsh-sdk'), stampOf('ios'));
  });
}

async function fetchAndroid() {
  const target = join(root, 'android/vendor');
  if (current(target, 'android')) return;
  const zip = await archive('android');
  const { version } = pin;
  unpack(zip, target, (scratch, staged) => {
    const dir = join(staged, 'maven/com/longbridge/nsh/nsh', version);
    mkdirSync(dir, { recursive: true });
    renameSync(
      join(scratch, 'nsh-embed-android/nsh.aar'),
      join(dir, `nsh-${version}.aar`),
    );
    writeFileSync(
      join(dir, `nsh-${version}.pom`),
      `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.longbridge.nsh</groupId>
  <artifactId>nsh</artifactId>
  <version>${version}</version>
  <packaging>aar</packaging>
</project>
`,
    );
    writeFileSync(join(staged, '.nsh-sdk'), stampOf('android'));
  });
}

const platform = process.argv[2] ?? 'all';
if (!['ios', 'android', 'all'].includes(platform)) {
  process.stderr.write('usage: fetch-nsh-sdk.mjs [ios|android|all]\n');
  process.exit(2);
}
if (platform !== 'android') await fetchIos();
if (platform !== 'ios') await fetchAndroid();
