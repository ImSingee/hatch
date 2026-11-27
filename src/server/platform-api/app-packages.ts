/**
 * Public RPCs of native App packages: the live signed package and the trust
 * material shells verify it with. Any valid credential may call them.
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { db } from '~/db';
import { liveNativePackage } from '~server/apps/native/packages';
import { nshAppId } from '~server/apps/native/nsh-config';
import { runtimeTrust } from '~server/apps/native/signing-keys';
import { AppService } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/app_pb';
import { publicApiError, publicError } from './errors';

/** Bytes per streamed message. */
const PACKAGE_CHUNK_BYTES = 256 * 1024;

async function appId(idOrSlug: string): Promise<string> {
  const lookup = (where: { id: string } | { slug: string }) =>
    db.query.apps.findFirst({ where, columns: { id: true } });
  const row =
    (await lookup({ id: idOrSlug })) ?? (await lookup({ slug: idOrSlug }));
  if (!row) throw publicApiError('NOT_FOUND');
  return row.id;
}

export function registerAppPackageApi(router: ConnectRouter): void {
  router.rpc(AppService.method.getAppPackage, async function* (input, context) {
    let signed;
    try {
      signed = await liveNativePackage(await appId(input.id));
    } catch (error) {
      throw publicError(error);
    }
    yield {
      part: {
        case: 'package',
        value: {
          appId: signed.appId,
          deploymentId: signed.deploymentId,
          version: signed.version,
          build: signed.build,
          nshAppId: nshAppId(signed.appId),
          nshVersion: signed.nshVersion ?? undefined,
          sha256: signed.sha256,
          size: signed.size,
          keyId: signed.keyId,
          bytecode: signed.bytecode,
        },
      },
    };
    for (let at = 0; at < signed.bytes.length; at += PACKAGE_CHUNK_BYTES) {
      if (context.signal.aborted) return;
      yield {
        part: {
          case: 'chunk',
          value: signed.bytes.subarray(at, at + PACKAGE_CHUNK_BYTES),
        },
      };
    }
  });
  router.rpc(AppService.method.getAppRuntimeTrust, async () => {
    try {
      const trust = await runtimeTrust();
      return {
        trust: {
          initialized: trust.initialized,
          appIdPattern: trust.appIdPattern,
          roots: trust.roots,
          releaseKeys: trust.releaseKeys.map((key) => ({
            ...key,
            notBefore: key.notBefore.toISOString(),
            notAfter: key.notAfter.toISOString(),
          })),
          revocations: trust.revocations
            ? {
                ...trust.revocations,
                issuedAt: trust.revocations.issuedAt.toISOString(),
              }
            : undefined,
        },
      };
    } catch (error) {
      throw publicError(error);
    }
  });
}
