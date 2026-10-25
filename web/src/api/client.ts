import type { ApiErrorBody, SessionStatus } from '@gtfs-rt-debugger/shared';

export const API_BASE = '/api/v1';

/** A request that has not answered by now is treated as a network failure. */
export const REQUEST_TIMEOUT_MS = 8_000;

/**
 * A failed API call. `network` means no HTTP answer arrived (offline, refused, timed out),
 * `http` a non-2xx response (with the error envelope's `code` when it parsed), `parse` a 2xx
 * response whose body was not JSON.
 */
export class ApiError extends Error {
  readonly kind: 'network' | 'http' | 'parse';
  /** HTTP status, or null when there was no response. */
  readonly status: number | null;
  /** The error envelope's `code`, or null when the response carried none. */
  readonly code: string | null;

  constructor(
    kind: ApiError['kind'],
    message: string,
    options: { status?: number | null; code?: string | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }

  /** The "Can't reach the server" cases: no answer, or a 5xx. */
  get isUnreachable(): boolean {
    return this.kind === 'network' || (this.status !== null && this.status >= 500);
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = value.error;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

async function request<T>(method: 'GET' | 'POST', path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    // A caller's abort is not a failure; let it propagate untouched.
    if (signal?.aborted) throw cause;
    throw new ApiError('network', 'Network request failed', { cause });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    // A body that cuts off or times out mid-read is a network failure; anything else is bad JSON.
    if (!(cause instanceof SyntaxError)) {
      throw new ApiError('network', 'Network request failed', { cause });
    }
    if (response.ok) throw new ApiError('parse', 'Response was not valid JSON', { cause });
    body = undefined;
  }

  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new ApiError('http', body.error.message, {
        status: response.status,
        code: body.error.code,
      });
    }
    throw new ApiError('http', `Request failed with status ${response.status}`, {
      status: response.status,
    });
  }
  return body as T;
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, signal);
}

export function startSession(signal?: AbortSignal): Promise<SessionStatus> {
  return request<SessionStatus>('POST', '/session/start', signal);
}

export function pingSession(signal?: AbortSignal): Promise<SessionStatus> {
  return request<SessionStatus>('POST', '/session/ping', signal);
}
