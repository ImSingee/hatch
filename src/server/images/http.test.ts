import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  CredentialError: class CredentialError extends Error {},
  authenticateCredential: vi.fn<() => Promise<unknown>>(),
  readAppIcon:
    vi.fn<
      (
        id: string,
        size: number,
      ) => Promise<{ key: string; body: Buffer } | null>
    >(),
  readCandidate: vi.fn<(id: string) => Promise<Buffer | null>>(),
  readUserAvatar:
    vi.fn<
      (
        id: string,
        size: number,
      ) => Promise<{ key: string; body: Buffer } | null>
    >(),
}));
vi.mock('~server/auth/credentials', () => ({
  CredentialError: mocks.CredentialError,
  authenticateCredential: mocks.authenticateCredential,
}));
vi.mock('~server/apps/icon', () => ({ readAppIcon: mocks.readAppIcon }));
vi.mock('~server/user-avatar-store', () => ({
  readUserAvatar: mocks.readUserAvatar,
}));
vi.mock('~/db', () => ({
  db: {
    query: {
      apps: {
        findMany: async () => [
          { id: 'app-1', icon: 'key1' },
          { id: 'app-2', icon: null },
        ],
      },
    },
  },
}));
vi.mock('./candidates', () => ({ readCandidate: mocks.readCandidate }));
vi.mock('~server/agent-runner/run-auth', () => ({
  RunTokenError: class RunTokenError extends Error {},
}));

const {
  handleAppIconIndexRequest,
  handleAppIconRequest,
  handleImageCandidateRequest,
  handleUserAvatarRequest,
} = await import('./http');

const PNG = Buffer.from('png-bytes');
const CANDIDATE = 'a'.repeat(32);
const icon = (query = '', headers?: HeadersInit) =>
  handleAppIconRequest({
    request: new Request(`http://hatch.test/api/app/app-1/icon${query}`, {
      headers,
    }),
  });
const avatar = (userId: string, query = '') =>
  handleUserAvatarRequest({
    request: new Request(
      `http://hatch.test/api/users/${userId}/avatar${query}`,
    ),
  });
const candidate = (id: string) =>
  handleImageCandidateRequest({
    request: new Request(`http://hatch.test/api/images/candidates/${id}`),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateCredential.mockResolvedValue({ run: null });
  mocks.readAppIcon.mockResolvedValue({ key: 'key1', body: PNG });
  mocks.readCandidate.mockResolvedValue(PNG);
  mocks.readUserAvatar.mockResolvedValue({ key: 'key2', body: PNG });
});

describe('stored image delivery', () => {
  it('requires a platform credential before reading anything', async () => {
    mocks.authenticateCredential.mockRejectedValue(new mocks.CredentialError());

    expect((await icon()).status).toBe(401);
    expect((await candidate(CANDIDATE)).status).toBe(401);
    expect((await avatar('user-1')).status).toBe(401);
    expect(
      (
        await handleAppIconIndexRequest({
          request: new Request('http://hatch.test/api/images/app-icons'),
        })
      ).status,
    ).toBe(401);
    expect(mocks.readAppIcon).not.toHaveBeenCalled();
    expect(mocks.readCandidate).not.toHaveBeenCalled();
    expect(mocks.readUserAvatar).not.toHaveBeenCalled();
  });

  it('serves a user avatar by user id, cached for good under its key', async () => {
    const current = await avatar('user-1', '?v=key2&size=256');
    expect(current.status).toBe(200);
    expect(current.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(mocks.readUserAvatar).toHaveBeenCalledWith('user-1', 256);
    expect((await avatar('user-1', '?size=100')).status).toBe(400);
    expect((await avatar('%E0%A4%A')).status).toBe(404);
    mocks.readUserAvatar.mockResolvedValue(null);
    expect((await avatar('user-1')).status).toBe(404);
  });

  it('caches an icon for good only under its current key', async () => {
    const current = await icon('?v=key1&size=64');
    expect(current.status).toBe(200);
    expect(current.headers.get('content-type')).toBe('image/png');
    expect(current.headers.get('x-content-type-options')).toBe('nosniff');
    expect(current.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
    expect(mocks.readAppIcon).toHaveBeenCalledWith('app-1', 64);

    for (const query of ['', '?v=older-key'])
      expect((await icon(query)).headers.get('cache-control')).toBe(
        'private, no-cache',
      );
    const revalidated = await icon('', { 'if-none-match': '"key1-128"' });
    expect(revalidated.status).toBe(304);
  });

  it('lists icon keys only for Apps that have an icon', async () => {
    const response = await handleAppIconIndexRequest({
      request: new Request('http://hatch.test/api/images/app-icons'),
    });
    expect(await response.json()).toEqual({ 'app-1': 'key1' });
  });

  it('serves only stored sizes and existing icons', async () => {
    expect((await icon('?size=100')).status).toBe(400);
    mocks.readAppIcon.mockResolvedValue(null);
    expect((await icon()).status).toBe(404);
  });

  it('serves candidates only by a well-formed id', async () => {
    expect((await candidate(CANDIDATE)).status).toBe(200);
    for (const id of ['short', `${CANDIDATE}%2F..`, 'A'.repeat(32)])
      expect((await candidate(id)).status).toBe(404);
    mocks.readCandidate.mockResolvedValue(null);
    expect((await candidate(CANDIDATE)).status).toBe(404);
  });
});
