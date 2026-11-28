/**
 * `packageBuild()` reads the package build number a native shell passes in
 * `host.params.packageBuild` (NSH's own `appInfo().build` stays the bundle's
 * compiled-in 1). The web player passes none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const params: Record<string, unknown> = {};

vi.mock('nsh', () => ({
  host: {
    params,
    call: vi.fn<() => Promise<unknown>>(),
    on: vi.fn<() => () => void>(),
  },
  setTheme: vi.fn<() => void>(),
}));

const { packageBuild } =
  await import('../../../../sdk-internal/app/src/native');

afterEach(() => {
  for (const key of Object.keys(params)) delete params[key];
});

describe('packageBuild', () => {
  it('is the build number the shell names', () => {
    params.packageBuild = 6;
    expect(packageBuild()).toBe(6);
  });

  it('is null where the shell names none or something else', () => {
    expect(packageBuild()).toBeNull();
    for (const value of [0, -1, 1.5, '6', null, Number.MAX_VALUE]) {
      params.packageBuild = value;
      expect(packageBuild()).toBeNull();
    }
  });
});
