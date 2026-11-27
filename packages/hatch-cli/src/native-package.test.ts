import { describe, expect, it } from 'vitest';
import { parseNativePackageCommand, trustFiles } from './native-package';

const parse = (...args: string[]) =>
  parseNativePackageCommand(['app', ...args], 0).command;

describe('hatch app package and runtime-trust arguments', () => {
  it('maps package to the App, the output and --force', () => {
    expect(parse('package', 'notes', '--out', 'notes.nshpkg')).toEqual({
      kind: 'package',
      app: 'notes',
      out: 'notes.nshpkg',
      force: false,
    });
    expect(
      parse('package', 'notes', '--out', 'notes.nshpkg', '--force', '--json'),
    ).toEqual({
      kind: 'package',
      app: 'notes',
      out: 'notes.nshpkg',
      force: true,
    });
    expect(parse('package', 'notes', '--out', '-')).toEqual({
      kind: 'package',
      app: 'notes',
      out: '-',
      force: false,
    });
  });

  it('maps runtime-trust with and without --out-dir', () => {
    expect(parse('runtime-trust')).toEqual({
      kind: 'runtime-trust',
      outDir: undefined,
    });
    expect(parse('runtime-trust', '--out-dir', 'trust', '--json')).toEqual({
      kind: 'runtime-trust',
      outDir: 'trust',
    });
  });

  it.each([
    [['package', 'notes']],
    [['package', '--out', 'a.nshpkg']],
    [['package', 'notes', 'other', '--out', 'a.nshpkg']],
    [['package', 'notes', '--out', '']],
    [['package', 'notes', '--out', '-', '--json']],
    [['package', 'notes', '--out', '-', '--force']],
    [['package', 'notes', '--out', 'a.nshpkg', '--out-dir', 'x']],
    [['runtime-trust', 'notes']],
    [['runtime-trust', '--out-dir', '']],
    [['runtime-trust', '--out', 'x']],
  ])('rejects %j before any request', (args) => {
    expect(() => parse(...args)).toThrow(
      expect.objectContaining({ code: 'invalid_arguments' }),
    );
  });

  it('names the trust files nsh verify reads', () => {
    expect(
      trustFiles({
        initialized: true,
        appIdPattern: 'dev.hatch.app.*',
        roots: [{ keyId: 'aaaaaaaaaaaaaaaa', publicKey: 'cm9vdA==' }],
        releaseKeys: [
          {
            keyId: 'bbbbbbbbbbbbbbbb',
            publicKey: 'cmVsZWFzZQ==',
            certificate: '{"body":"e30=","signer":"a","signature":"b"}',
            apps: ['dev.hatch.app.*'],
            notBefore: '2026-11-27T00:00:00.000Z',
            notAfter: '2036-11-25T00:00:00.000Z',
            active: true,
            revoked: false,
          },
        ],
        revocations: {
          sequence: 1,
          issuedAt: '2026-11-27T00:00:00.000Z',
          keyIds: [],
          packageSha256s: [],
          signed: '{"body":"e30=","signer":"a","signature":"c"}',
        },
      }),
    ).toEqual({
      'root-aaaaaaaaaaaaaaaa.pub': 'cm9vdA==\n',
      'release-bbbbbbbbbbbbbbbb.cert':
        '{"body":"e30=","signer":"a","signature":"b"}\n',
      'revocations.json': '{"body":"e30=","signer":"a","signature":"c"}\n',
    });
  });
});
