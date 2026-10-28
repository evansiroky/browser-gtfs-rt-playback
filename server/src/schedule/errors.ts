import type { StatusError } from '@gtfs-rt-debugger/shared';
import { FetchError } from '../fetch/bounded-fetch.js';

/**
 * A schedule that cannot be loaded for a reason found while reading it. `code` is one of
 * `missing_file`, `bad_zip`, `bad_csv`, `too_large` or `invalid_schedule`; the message is generic
 * and never contains the feed URL.
 */
export class ScheduleLoadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScheduleLoadError';
    this.code = code;
  }
}

/** The status error for any failure of a load; unexpected failures are not described. */
export function toStatusError(error: unknown): StatusError {
  if (error instanceof FetchError) return error.toStatusError();
  if (error instanceof ScheduleLoadError) return { code: error.code, message: error.message };
  return { code: 'internal_error', message: 'The schedule could not be loaded unexpectedly.' };
}
