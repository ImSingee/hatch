import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { PublicErrorSchema } from '../../../packages/hatch-platform-api/gen/hatch/platform/v1/error_pb';
import { AppError } from '~server/errors';
import { RunTokenError } from '~server/agent-runner/run-auth';
import { DataMigrationApprovalRequired } from '~server/apps/data-table/migration-errors';
import { AppManifestValidationError } from '~server/apps/manifest-validation';
import { DeploymentRequestError } from '~server/apps/deployment-errors';
import { ThemeValidationError } from '~server/theme-errors';

const definitions = {
  BAD_REQUEST: [Code.InvalidArgument, 400, 'Invalid request.'],
  APP_MANIFEST_INVALID: [Code.InvalidArgument, 400, 'App manifest is invalid.'],
  THEME_INVALID: [Code.InvalidArgument, 400, 'Theme is invalid.'],
  UNAUTHORIZED: [Code.Unauthenticated, 401, 'Authentication required.'],
  INVALID_TOKEN: [Code.Unauthenticated, 401, 'Invalid Run credential.'],
  RUN_ENDED: [Code.Unauthenticated, 401, 'Run is no longer live.'],
  SESSION_REQUIRED: [Code.PermissionDenied, 403, 'A user session is required.'],
  FORBIDDEN: [Code.PermissionDenied, 403, 'Cross-origin request denied.'],
  NOT_FOUND: [Code.NotFound, 404, 'Resource not found.'],
  CONFLICT: [Code.Aborted, 409, 'Resource conflict.'],
  RESOURCE_GENERATION_CONFLICT: [
    Code.Aborted,
    409,
    'Resource was deleted or recreated. Fetch its current source.',
  ],
  PAYLOAD_TOO_LARGE: [Code.ResourceExhausted, 413, 'Payload too large.'],
  TOO_MANY_REQUESTS: [Code.ResourceExhausted, 429, 'Too many requests.'],
  UNSUPPORTED_MEDIA_TYPE: [
    Code.InvalidArgument,
    415,
    'Unsupported content type.',
  ],
  INTERNAL_SERVER_ERROR: [Code.Internal, 500, 'Internal server error.'],
  SERVICE_UNAVAILABLE: [Code.Unavailable, 503, 'Service unavailable.'],
  BUILDER_UNAVAILABLE: [
    Code.Aborted,
    409,
    'This platform has no dedicated Builder.',
  ],
  BUILDER_OFFLINE: [
    Code.Aborted,
    409,
    'No Builder has connected to this platform recently.',
  ],
  DEPLOYMENT_NOT_CANCELABLE: [
    Code.Aborted,
    409,
    'The deployment can no longer be canceled.',
  ],
  DEPLOYMENT_NOT_AWAITING_ARTIFACT: [
    Code.Aborted,
    409,
    'The deployment does not accept a build package now.',
  ],
  COMMIT_NOT_ON_MASTER: [
    Code.Aborted,
    409,
    'The commit is not on master. Push it, or deploy a commit on master.',
  ],
  APP_NOT_DEPLOYED: [
    Code.FailedPrecondition,
    409,
    'The App has no live deployment.',
  ],
  APP_NOT_NATIVE: [
    Code.FailedPrecondition,
    409,
    'The live deployment has no native frontend.',
  ],
  APP_PACKAGE_UNAVAILABLE: [
    Code.FailedPrecondition,
    409,
    'The live deployment has no native package. Deploy the App again.',
  ],
  GATEWAY_TIMEOUT: [
    Code.DeadlineExceeded,
    504,
    'SQL operation timed out. Inspect affected data before retrying.',
  ],
} as const;
export type PublicErrorCode = keyof typeof definitions;

/** `AppError.code`s that are public codes too. */
const DOMAIN_CODES = {
  'deployments.commitNotOnMaster': 'COMMIT_NOT_ON_MASTER',
  'nativePackages.appNotDeployed': 'APP_NOT_DEPLOYED',
  'nativePackages.appNotNative': 'APP_NOT_NATIVE',
  'nativePackages.unavailable': 'APP_PACKAGE_UNAVAILABLE',
} as const satisfies Record<string, PublicErrorCode>;

export function publicApiError(code: PublicErrorCode, message?: string) {
  const [connectCode, httpStatus, fallback] = definitions[code];
  return new ConnectError(message ?? fallback, connectCode, undefined, [
    {
      desc: PublicErrorSchema,
      value: create(PublicErrorSchema, { code, httpStatus }),
    },
  ]);
}

/** Preserve declared business errors, never exception text or decoded input. */
export function publicError(
  error: unknown,
  redactDomain = false,
): ConnectError {
  if (error instanceof DataMigrationApprovalRequired)
    return publicApiError(
      'CONFLICT',
      `Destructive Data Table migration requires explicit approval.\nApproval token: ${error.plan.approvalToken}\nInspect schema changes before retrying with --allow-destructive-data-migration and --data-migration-approval-token.`,
    );
  if (error instanceof DeploymentRequestError)
    return publicApiError(error.code, redactDomain ? undefined : error.message);
  // Its message names manifest fields and schema rules, never authored values.
  if (error instanceof AppManifestValidationError)
    return publicApiError(
      'APP_MANIFEST_INVALID',
      redactDomain ? undefined : error.message,
    );
  // Its message names theme keys and colour roles, never other input.
  if (error instanceof ThemeValidationError)
    return publicApiError(
      'THEME_INVALID',
      redactDomain ? undefined : error.message,
    );
  if (error instanceof AppError && error.status === 504)
    return publicApiError('GATEWAY_TIMEOUT');
  if (error instanceof AppError && error.status === 503)
    return publicApiError('SERVICE_UNAVAILABLE');
  if (error instanceof RunTokenError)
    return publicApiError(
      error.code === 'invalid_token' ? 'INVALID_TOKEN' : 'RUN_ENDED',
    );
  // Domain errors with a stable code of their own keep it, as the Web UI
  // sees it, instead of collapsing into their HTTP status.
  if (error instanceof AppError && error.code && error.code in DOMAIN_CODES)
    return publicApiError(
      DOMAIN_CODES[error.code as keyof typeof DOMAIN_CODES],
      redactDomain ? undefined : error.message,
    );
  if (error instanceof AppError && error.status < 500) {
    const codes: Record<number, PublicErrorCode> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE',
      429: 'TOO_MANY_REQUESTS',
    };
    return publicApiError(
      codes[error.status] ?? 'BAD_REQUEST',
      redactDomain ? undefined : error.message,
    );
  }
  if (error instanceof ConnectError) {
    if (error.findDetails(PublicErrorSchema).length) return error;
    // Protovalidate's details contain field paths and rules, not input values.
    if (error.code === Code.InvalidArgument) {
      const safe = publicApiError('BAD_REQUEST');
      safe.details.push(...error.details);
      return safe;
    }
    if (error.code === Code.ResourceExhausted)
      return publicApiError('PAYLOAD_TOO_LARGE');
    if (error.code === Code.Canceled || error.code === Code.DeadlineExceeded)
      return error;
  }
  return publicApiError('INTERNAL_SERVER_ERROR');
}
