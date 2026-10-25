import type { StatusError } from '@gtfs-rt-debugger/shared';
import type { Clock } from '../clock.js';
import type { SecretUrl } from '../secret-url.js';

export const MAX_REDIRECTS = 3;

/**
 * A failed feed fetch. `code` is one of `http_status_<n>`, `timeout`, `too_large`,
 * `too_many_redirects`, `redirect_not_allowed`, `network_error`, `aborted` (callers add their own,
 * e.g. `decode_failed`). The message is generic and never contains the URL, and no `cause` is
 * attached, because the underlying error may name the host or query string.
 */
export class FetchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }

  toStatusError(): StatusError {
    return { code: this.code, message: this.message };
  }
}

export interface BoundedFetchOptions {
  clock: Clock;
  /** Applies to the whole exchange: connecting, redirects and reading the body. */
  timeoutMs: number;
  /** Limit on the body after any `Content-Encoding` (gzip) is decoded. */
  maxBytes: number;
  /** Aborts the fetch; the generator then throws `FetchError('aborted')`. */
  signal?: AbortSignal;
}

/**
 * Fetches a configured feed URL and yields its body in chunks, enforcing the timeout and the
 * size limit while the body is read (the fetch is aborted as soon as the limit is crossed).
 * Redirects are followed manually: at most {@link MAX_REDIRECTS} hops, to `http`/`https` only.
 * The response may be gzip-encoded; the fetch decodes it as the body streams.
 */
export async function* boundedFetch(
  url: SecretUrl,
  { clock, timeoutMs, maxBytes, signal }: BoundedFetchOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) controller.abort();

  const failure = (): FetchError =>
    timedOut
      ? new FetchError('timeout', `The feed did not respond within ${timeoutMs} ms.`)
      : controller.signal.aborted
        ? new FetchError('aborted', 'The fetch was abandoned.')
        : new FetchError('network_error', 'The feed could not be reached.');

  try {
    let target = url.reveal();
    let response: Response;
    for (let hops = 0; ; hops++) {
      try {
        response = await fetch(target, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'application/x-protobuf, application/octet-stream, */*',
            'accept-encoding': 'gzip, deflate',
          },
        });
      } catch {
        throw failure();
      }
      if (response.status < 300 || response.status > 399 || !response.headers.has('location'))
        break;
      await response.body?.cancel().catch(() => undefined);
      if (hops >= MAX_REDIRECTS) {
        throw new FetchError(
          'too_many_redirects',
          `The feed redirected more than ${MAX_REDIRECTS} times.`,
        );
      }
      let next: URL;
      try {
        next = new URL(response.headers.get('location') ?? '', target);
      } catch {
        throw new FetchError('redirect_not_allowed', 'The feed redirected to an invalid location.');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new FetchError('redirect_not_allowed', 'The feed redirected to a non-HTTP location.');
      }
      target = next;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchError(
        `http_status_${response.status}`,
        `The feed responded with HTTP ${response.status}.`,
      );
    }
    if (!response.body) return;

    const reader = response.body.getReader();
    let total = 0;
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        throw failure();
      }
      if (chunk.done) return;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new FetchError('too_large', `The feed response exceeded ${maxBytes} bytes.`);
      }
      yield chunk.value;
    }
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Releases the connection if the body was not read to the end.
    controller.abort();
  }
}

/** {@link boundedFetch}, collected into one buffer. */
export async function fetchAll(url: SecretUrl, options: BoundedFetchOptions): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of boundedFetch(url, options)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
