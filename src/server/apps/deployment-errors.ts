/** Server-only: deployment requests a caller cannot make, by stable code. */
import { AppError } from '../errors';

export type DeploymentRequestErrorCode =
  | 'BUILDER_UNAVAILABLE'
  | 'DEPLOYMENT_NOT_CANCELABLE'
  | 'DEPLOYMENT_NOT_AWAITING_ARTIFACT';

export class DeploymentRequestError extends AppError {
  constructor(
    readonly code: DeploymentRequestErrorCode,
    message: string,
  ) {
    super(message, 409);
    this.name = 'DeploymentRequestError';
  }
}
