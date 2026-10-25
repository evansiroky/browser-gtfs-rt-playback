import type { ApiErrorBody, ApiErrorCode } from '@gtfs-rt-debugger/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Throw from any API route or hook to answer with the error envelope (conventions.md "Errors").
 * The message is sent to the client as is: keep it URL-free and generic.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
  }
}

export function errorBody(code: ApiErrorCode, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function notFoundError(): ApiError {
  return new ApiError(404, 'not_found', 'No such endpoint.');
}

/**
 * Error handler for the API: {@link ApiError}s as given; framework client errors (malformed
 * body, unsupported content type, ...) as `400 bad_request`; anything else as `500
 * internal_error`, logged server-side and never described to the client.
 */
export function handleApiError(
  error: FastifyError | ApiError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ApiError) {
    return reply
      .code(error.statusCode)
      .headers(error.headers)
      .send(errorBody(error.code, error.message));
  }
  const status = error.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return reply.code(400).send(errorBody('bad_request', 'The request is malformed.'));
  }
  request.log.error({ err: error }, 'unhandled error');
  return reply.code(500).send(errorBody('internal_error', 'An unexpected error occurred.'));
}
