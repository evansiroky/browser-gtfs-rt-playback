/** Agency-local time helpers. A service date is `YYYYMMDD`; GTFS times count from "noon minus 12 h". */

export const SECONDS_PER_DAY = 86_400;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock offset from UTC at an instant, in milliseconds. */
function offsetMs(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const wall = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wall - Math.floor(instantMs / 1000) * 1000;
}

/** The agency-local calendar date of an instant, as `YYYYMMDD`. */
export function serviceDateOf(instant: Date, timeZone: string): string {
  const wall = new Date(instant.getTime() + offsetMs(instant.getTime(), timeZone));
  return toYyyymmdd(wall);
}

function toYyyymmdd(utcDate: Date): string {
  const y = String(utcDate.getUTCFullYear()).padStart(4, '0');
  const m = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function fromYyyymmdd(date: string): Date {
  if (!/^\d{8}$/.test(date)) throw new RangeError(`not a YYYYMMDD date: ${date}`);
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
}

/** Calendar arithmetic on a service date. */
export function addDays(date: string, days: number): string {
  const d = fromYyyymmdd(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toYyyymmdd(d);
}

/** 0 = Sunday .. 6 = Saturday, the weekday of a calendar date. */
export function weekdayOf(date: string): number {
  return fromYyyymmdd(date).getUTCDay();
}

/** The instant GTFS times on a service date count from: local noon minus 12 hours. */
export function serviceDayStart(date: string, timeZone: string): Date {
  const noonWall = fromYyyymmdd(date).getTime() + 12 * 3_600_000;
  const firstGuess = noonWall - offsetMs(noonWall, timeZone);
  const noon = noonWall - offsetMs(firstGuess, timeZone);
  return new Date(noon - 12 * 3_600_000);
}

/** Epoch seconds of a GTFS time (seconds from the day start) on a service date. */
export function instantSeconds(date: string, secondsOfDay: number, timeZone: string): number {
  return serviceDayStart(date, timeZone).getTime() / 1000 + secondsOfDay;
}

/** `HH:MM:SS`, hours may exceed 23. */
export function formatHms(totalSeconds: number): string {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new RangeError(`not a non-negative whole number of seconds: ${totalSeconds}`);
  }
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function parseHms(hms: string): number {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(hms);
  if (!match) throw new RangeError(`not an HH:MM:SS time: ${hms}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * The instant `hms` (GTFS semantics, may exceed 24:00:00) on service date `date`. Lets a test aim
 * a scenario at a moment such as "00:20 on 2026-10-14" without doing timezone arithmetic.
 */
export function agencyInstant(date: string, hms: string, timeZone: string): Date {
  return new Date(serviceDayStart(date, timeZone).getTime() + parseHms(hms) * 1000);
}
