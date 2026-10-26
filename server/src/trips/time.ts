/**
 * Agency-local calendar arithmetic (principles.md "Agency-local time"). A service date is a
 * `YYYYMMDD` string; GTFS times count from the service day's "noon minus 12 hours", which is
 * midnight except on a day with a daylight-saving change.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** The wall clock of `instantMs` in the zone, read as if it were UTC, in epoch milliseconds. */
function wallClockMs(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts['year']!,
    parts['month']! - 1,
    parts['day']!,
    parts['hour']!,
    parts['minute']!,
    parts['second']!,
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function format(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
}

/** The calendar date at `instantMs` in the agency timezone, as a service date. */
export function agencyDate(instantMs: number, timeZone: string): string {
  return format(new Date(wallClockMs(instantMs, timeZone)));
}

/** A real calendar date written `YYYYMMDD`. */
export function isServiceDate(text: string | null | undefined): text is string {
  if (text === null || text === undefined || !/^\d{8}$/.test(text)) return false;
  const date = parse(text);
  return format(date) === text;
}

function parse(serviceDate: string): Date {
  return new Date(
    Date.UTC(
      Number(serviceDate.slice(0, 4)),
      Number(serviceDate.slice(4, 6)) - 1,
      Number(serviceDate.slice(6, 8)),
    ),
  );
}

export function addDays(serviceDate: string, days: number): string {
  const date = parse(serviceDate);
  date.setUTCDate(date.getUTCDate() + days);
  return format(date);
}

const HOUR_MS = 3_600_000;

/**
 * The instant GTFS times on a service date count from, in epoch seconds: noon of that date in
 * the agency timezone minus twelve hours of elapsed time (data-model.md "Service date").
 */
export function serviceDayStart(serviceDate: string, timeZone: string): number {
  const noonWall = parse(serviceDate).getTime() + 12 * HOUR_MS;
  // The offset is read at the instant the first guess lands on, which is right unless a
  // transition lies between the guess and noon itself; none does at noon in any real zone.
  const guess = noonWall - (wallClockMs(noonWall, timeZone) - noonWall);
  const noon = noonWall - (wallClockMs(guess, timeZone) - guess);
  return (noon - 12 * HOUR_MS) / 1000;
}
