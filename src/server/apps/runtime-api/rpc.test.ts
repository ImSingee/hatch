import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findApp: vi.fn<(options?: unknown) => Promise<unknown>>(),
  findDeployment: vi.fn<(options?: unknown) => Promise<unknown>>(),
  getSession: vi.fn<(options: unknown) => Promise<unknown>>(),
  proxyAppRequest:
    vi.fn<
      (
        id: string,
        request: Request,
        stripPrefix: string,
        forwardPrefix: string,
        options: unknown,
      ) => Promise<Response>
    >(),
  BackendDeploymentChangedError: class extends Error {},
}));

vi.mock('~server/auth/credentials', () => ({
  authenticateCredential: mocks.getSession,
  CredentialError: class extends Error {},
}));
vi.mock('~/db', () => ({
  db: {
    query: {
      apps: { findFirst: mocks.findApp },
      deployments: { findFirst: mocks.findDeployment },
    },
  },
}));
vi.mock('~server/apps/runtime', () => ({
  BackendDeploymentChangedError: mocks.BackendDeploymentChangedError,
  proxyAppRequest: mocks.proxyAppRequest,
}));

vi.mock('~server/agent-runner/run-auth', () => ({
  RunTokenError: class extends Error {},
}));

import { handleRpcRequest } from './rpc';

describe('public app RPC route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    mocks.findApp.mockResolvedValue({
      status: 'deployed',
      currentDeploymentId: 'deployment-1',
      capabilities: { backend: true },
      signingSecret: 'signing-secret',
    });
    mocks.findDeployment.mockResolvedValue({ compatibilityVersion: null });
    mocks.proxyAppRequest.mockResolvedValue(new Response('proxied'));
  });

  it('strips the canonical RPC prefix', async () => {
    const request = new Request(
      'https://hatch.test/api/app/app-id/rpc/todos.list',
      {
        method: 'POST',
        body: '{}',
      },
    );

    const response = await handleRpcRequest({ request });

    expect(response.status).toBe(200);
    expect(mocks.proxyAppRequest).toHaveBeenCalledWith(
      'app-id',
      request,
      '/api/app/app-id/rpc',
      '',
      {
        signWithSecret: 'signing-secret',
        expectedDeploymentId: 'deployment-1',
      },
    );
  });

  it('serves a call that raced a deploy from the newly active deployment', async () => {
    // The app row was read just before the cutover committed.
    mocks.findApp
      .mockResolvedValueOnce({
        status: 'deployed',
        currentDeploymentId: 'deployment-1',
        capabilities: { backend: true },
        signingSecret: 'signing-secret',
      })
      .mockResolvedValue({
        status: 'deployed',
        currentDeploymentId: 'deployment-2',
        capabilities: { backend: true },
        signingSecret: 'signing-secret',
      });
    mocks.proxyAppRequest
      .mockRejectedValueOnce(new mocks.BackendDeploymentChangedError())
      .mockResolvedValue(new Response('proxied'));

    const response = await handleRpcRequest({
      request: new Request('https://hatch.test/api/app/app-id/rpc/todos.list', {
        method: 'POST',
        body: '{}',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.proxyAppRequest).toHaveBeenLastCalledWith(
      'app-id',
      expect.any(Request),
      '/api/app/app-id/rpc',
      '',
      {
        signWithSecret: 'signing-secret',
        expectedDeploymentId: 'deployment-2',
      },
    );

    // A second change in a row is reported instead of looping.
    mocks.proxyAppRequest.mockRejectedValue(
      new mocks.BackendDeploymentChangedError(),
    );
    const unavailable = await handleRpcRequest({
      request: new Request('https://hatch.test/api/app/app-id/rpc/todos.list'),
    });
    expect(unavailable.status).toBe(502);
  });

  it('rejects an authenticated RPC call below the compatibility minimum', async () => {
    mocks.findDeployment.mockResolvedValue({ compatibilityVersion: 0 });

    const response = await handleRpcRequest({
      request: new Request('https://hatch.test/api/app/app-id/rpc/todos.list'),
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toContain('cannot run');
    expect(mocks.proxyAppRequest).not.toHaveBeenCalled();
  });
});
