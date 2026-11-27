/**
 * The phone runtimes (mobile/native) grant every App exactly the host calls
 * the platform declares in its packages: their lists must be this one, in
 * this order, or an App's package and the shell's grant disagree.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NATIVE_HOST_CALLS } from './nsh-config';

const native = new URL('../../../../mobile/native/', import.meta.url);

/** The quoted `hatch.*` names from `start` to the first `end` after it. */
function namesIn(file: string, start: string, end: string): string[] {
  const source = readFileSync(new URL(file, native), 'utf8');
  const from = source.indexOf(start);
  expect(from, `${file} lists the host calls`).toBeGreaterThan(-1);
  const list = source.slice(from, source.indexOf(end, from + start.length));
  return [...list.matchAll(/"(hatch\.[\w.]+)"/g)].map((match) => match[1]);
}

describe('phone runtime host calls', () => {
  it('iOS grants exactly the platform list', () => {
    expect(
      namesIn(
        'ios/HatchAppCore/Sources/HatchAppCore/HostCalls.swift',
        'static let names: [String] = [',
        ']',
      ),
    ).toEqual([...NATIVE_HOST_CALLS]);
  });

  it('Android grants exactly the platform list', () => {
    expect(
      namesIn(
        'android/core/src/main/kotlin/dev/hatch/app/core/HostBridge.kt',
        'listOf(',
        ')',
      ),
    ).toEqual([...NATIVE_HOST_CALLS]);
  });
});
