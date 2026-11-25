import { Code } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { publicError as cliPublicError } from '../../../packages/hatch-cli/src/client';
import { publicError } from '~server/platform-api/errors';
import { parseSourceManifest } from './manifest';
import { AppManifestValidationError } from './manifest-validation';

vi.mock('~server/agent-runner/run-auth', () => ({
  RunTokenError: class RunTokenError extends Error {},
}));

const SECRET = 'sk-live-0123456789abcdef';

function rejection(raw: unknown): AppManifestValidationError {
  let thrown: unknown;
  try {
    parseSourceManifest(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AppManifestValidationError);
  return thrown as AppManifestValidationError;
}

describe('App manifest validation errors', () => {
  it('names each field to fix without echoing authored values', () => {
    const error = rejection({
      id: 'demo',
      name: 'Demo',
      backendMode: SECRET,
      capabilities: { frontend: SECRET, [`${SECRET}\u001b[2J`]: true },
      app: {
        entry: 'app/main.tsx',
        routes: [
          { path: `/${SECRET}`, description: 'One' },
          { path: `/${SECRET}`, description: 'Two' },
        ],
      },
      unknownTopLevel: SECRET,
    });

    expect(error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'backendMode',
        'capabilities.frontend',
        'capabilities[…]',
        'app.routes[1].path',
        'unknownTopLevel',
      ]),
    );
    expect(error.message).toMatch(/^App manifest is invalid\./);
    expect(error.message).toContain('- unknownTopLevel: unknown field');
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain('\u001b');
  });

  it('maps to APP_MANIFEST_INVALID and the CLI argument exit status', () => {
    const error = rejection({
      id: 'demo',
      name: 'Demo',
      capabilities: {},
      x: 1,
    });
    const publicApi = publicError(error.inFile('manifest.ts'));
    expect(publicApi.code).toBe(Code.InvalidArgument);
    expect(publicApi.findDetails(PublicErrorSchema)[0]).toMatchObject({
      code: 'APP_MANIFEST_INVALID',
      httpStatus: 400,
    });

    const cli = cliPublicError(publicApi);
    expect(cli).toMatchObject({
      code: 'APP_MANIFEST_INVALID',
      exitCode: 2,
      httpStatus: 400,
    });
    expect(cli.message).toBe(
      'manifest.ts is invalid. Fix these fields and deploy again:\n' +
        '- x: unknown field; remove it',
    );
  });
});
