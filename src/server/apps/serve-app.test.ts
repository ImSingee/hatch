import { beforeEach, expect, it, vi } from 'vitest';
import { LATEST_APP_COMPATIBILITY_VERSION } from '~/app-compatibility';

const mocks = vi.hoisted(() => ({
  liveAppDeployment:
    vi.fn<(id: string, capability: string) => Promise<unknown>>(),
  readLiveBuildFile: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('~agent/paths', () => ({
  appBuildDir: (id: string) => `/workspace/build/${id}`,
}));
vi.mock('./access', () => ({
  liveAppDeployment: mocks.liveAppDeployment,
}));
vi.mock('./build-identity', () => ({
  readLiveBuildFile: mocks.readLiveBuildFile,
}));

import { NATIVE_PLAYER_CSP, serveAppAppFile } from './serve-app';

beforeEach(() => {
  vi.clearAllMocks();
});

it('returns a newer-platform 503 before reading frontend files', async () => {
  mocks.liveAppDeployment.mockResolvedValue({
    state: 'unsupported',
    compatibility: {
      version: LATEST_APP_COMPATIBILITY_VERSION + 1,
      latestVersion: LATEST_APP_COMPATIBILITY_VERSION,
      minimumSupportedVersion: 1,
      isSupported: false,
      isLatest: false,
    },
  });

  const response = await serveAppAppFile('example', 'index.html');

  expect(response.status).toBe(503);
  await expect(response.text()).resolves.toMatch(
    /newer than this platform's latest supported.*Update the platform/,
  );
  expect(mocks.readLiveBuildFile).not.toHaveBeenCalled();
});

it('sets the native player CSP only on native App frames', async () => {
  mocks.readLiveBuildFile.mockResolvedValue({
    ok: true,
    data: Buffer.from('<!doctype html>'),
  });
  const serve = async (app: Record<string, unknown>) => {
    mocks.liveAppDeployment.mockResolvedValue({
      state: 'live',
      deploymentId: 'deployment-1',
      manifest: { app },
    });
    return serveAppAppFile('example', '');
  };

  const native = await serve({ url: '/app/example', runtime: 'native' });
  expect(native.headers.get('content-security-policy')).toBe(NATIVE_PLAYER_CSP);
  expect(NATIVE_PLAYER_CSP).toContain("connect-src 'self'");
  expect(NATIVE_PLAYER_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");

  const web = await serve({ url: '/app/example' });
  expect(web.headers.get('content-security-policy')).toBeNull();
});
