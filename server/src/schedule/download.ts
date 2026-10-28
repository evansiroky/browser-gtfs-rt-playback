import type { Clock } from '../clock.js';
import { boundedFetch } from '../fetch/bounded-fetch.js';
import type { SecretUrl } from '../secret-url.js';

/** A downloaded body kept as the chunks it arrived in: no contiguous allocation, no copy. */
export interface ChunkedBody {
  readonly chunks: readonly Uint8Array[];
  readonly size: number;
}

export interface DownloadOptions {
  clock: Clock;
  timeoutMs: number;
  /** Hard cap on the downloaded bytes; the fetch is aborted as soon as it is crossed. */
  maxBytes: number;
  signal: AbortSignal;
}

/**
 * Downloads the schedule zip (feed-ingest.md "Schedule"). Throws `FetchError` (`timeout`,
 * `too_large`, `http_status_<n>`, `network_error`, ...), whose messages never name the URL.
 */
export async function downloadSchedule(
  url: SecretUrl,
  { clock, timeoutMs, maxBytes, signal }: DownloadOptions,
): Promise<ChunkedBody> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of boundedFetch(url, { clock, timeoutMs, maxBytes, signal })) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return { chunks, size };
}
