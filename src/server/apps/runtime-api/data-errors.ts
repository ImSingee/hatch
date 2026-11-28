/** HTTP responses for Data Table failures, shared by every Data route. */
import { ZodError } from 'zod';
import { AppError, errorResponse } from '~server/errors';

const DATA_CONFLICT_SQLSTATES = new Set(['23503', '23505', '23P01']);
const DATA_INVALID_SQLSTATES = new Set([
  '22001',
  '22003',
  '22007',
  '22008',
  '22P02',
  '23502',
  '23514',
]);

function sqlState(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== 'PostgresError') return;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function dataErrorResponse(error: unknown): Response {
  if (error instanceof AppError) return errorResponse(error);
  if (error instanceof ZodError) {
    return new Response(error.issues[0]?.message ?? 'Invalid data request.', {
      status: 400,
    });
  }
  const code = sqlState(error);
  if (code && DATA_CONFLICT_SQLSTATES.has(code)) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        status: 409,
      },
    );
  }
  if (code && DATA_INVALID_SQLSTATES.has(code)) {
    return new Response(
      error instanceof Error ? error.message : String(error),
      {
        status: 400,
      },
    );
  }
  // Connection failures, timeouts, and other infrastructure errors must stay
  // retryable for the realtime client. It stops permanently on ordinary 4xx.
  return errorResponse(error, 500);
}
