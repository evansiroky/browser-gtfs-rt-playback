const GTFS_TIME = /^\s*(\d{1,3}):([0-5]\d):([0-5]\d)\s*$/;

/**
 * Seconds from the service day's "noon minus 12 hours" for a GTFS `HH:MM:SS` time, which may
 * exceed 24:00:00 (a trip running past midnight). Null for an empty or malformed value.
 */
export function parseGtfsTime(text: string | undefined): number | null {
  const match = text === undefined ? null : GTFS_TIME.exec(text);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}
