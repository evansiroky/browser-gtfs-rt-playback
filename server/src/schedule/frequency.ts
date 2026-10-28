import type { Row } from './store.js';
import { parseGtfsTime } from './time.js';

/**
 * The most instances of one `frequencies.txt` row that may run at the same time; a trip with a
 * row that could exceed it is a `frequency_too_dense` configuration error (trip-activity.md).
 */
export const MAX_CONCURRENT_INSTANCES = 2_000;

/** What a `frequencies.txt` row says, each value null when it cannot be read. */
export interface FrequencyValues {
  /** Seconds from the service day start. */
  readonly startSecs: number | null;
  readonly endSecs: number | null;
  /** A positive whole number of seconds. */
  readonly headwaySecs: number | null;
}

export function readFrequencyRow(row: Row): FrequencyValues {
  const headway = /^\s*\d+\s*$/.test(row['headway_secs'] ?? '') ? Number(row['headway_secs']) : 0;
  return {
    startSecs: parseGtfsTime(row['start_time']),
    endSecs: parseGtfsTime(row['end_time']),
    headwaySecs: headway > 0 ? headway : null,
  };
}

/** Whether a row with this headway could have too many instances running at once. */
export function tooDense(templateDurationSecs: number, headwaySecs: number): boolean {
  return (
    Math.ceil((Math.max(templateDurationSecs, 0) + 60) / headwaySecs) > MAX_CONCURRENT_INSTANCES
  );
}
