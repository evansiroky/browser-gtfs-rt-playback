import type { ApiErrorBody, SessionStatus } from '@gtfs-rt-debugger/shared';

export const API_BASE = '/api/v1';

/** A request that has not answered by now is treated as a network failure. */
export const REQUEST_TIMEOUT_MS = 8_000;

/**
 * A failed API call. `network` means no HTTP answer arrived (offline, refused, timed out),
 * `http` a non-2xx response (with the error envelope's `code` when it parsed), `parse` a 2xx
 * response whose body was not JSON or not the expected shape.
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

  /**
   * The "Can't reach the server" cases: no answer, a 5xx, or a 2xx that is not what the API
   * sends (a captive portal or proxy page, say).
   */
  get isUnreachable(): boolean {
    return this.kind !== 'http' || (this.status !== null && this.status >= 500);
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

/**
 * An abort signal that fires after {@link REQUEST_TIMEOUT_MS} or when `caller` aborts, built by
 * hand because `AbortSignal.any`/`timeout` are missing from older browsers. `dispose` must run
 * when the request is over.
 */
function requestSignal(caller?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason);
  const timer = setTimeout(
    () => controller.abort(new DOMException('The request timed out', 'TimeoutError')),
    REQUEST_TIMEOUT_MS,
  );
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { signal?: AbortSignal; validate?: (body: unknown) => body is T } = {},
): Promise<T> {
  const { signal, dispose } = requestSignal(options.signal);
  try {
    return await send<T>(method, path, signal, options.signal, options.validate);
  } finally {
    dispose();
  }
}

async function send<T>(
  method: 'GET' | 'POST',
  path: string,
  signal: AbortSignal,
  caller: AbortSignal | undefined,
  validate: ((body: unknown) => body is T) | undefined,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal,
    });
  } catch (cause) {
    // A caller's abort is not a failure; let it propagate untouched.
    if (caller?.aborted) throw cause;
    throw new ApiError('network', 'Network request failed', { cause });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    if (caller?.aborted) throw cause;
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
  if (validate && !validate(body)) {
    throw new ApiError('parse', 'Response was not the expected shape');
  }
  return body as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The minimum a `SessionStatus` must have for the app to trust it. */
function isSessionStatus(body: unknown): body is SessionStatus {
  return (
    isObject(body) &&
    (body.state === 'dormant' || body.state === 'active') &&
    isObject(body.schedule) &&
    typeof body.schedule.state === 'string' &&
    isObject(body.realtime)
  );
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, { signal });
}

export function startSession(signal?: AbortSignal): Promise<SessionStatus> {
  return request('POST', '/session/start', { signal, validate: isSessionStatus });
}

export function pingSession(signal?: AbortSignal): Promise<SessionStatus> {
  return request('POST', '/session/ping', { signal, validate: isSessionStatus });
}
