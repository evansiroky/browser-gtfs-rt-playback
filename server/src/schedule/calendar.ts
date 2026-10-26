import type { Row } from './store.js';

/** Weekday columns of `calendar.txt`, Monday first. */
const WEEKDAY_COLUMNS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/** A service date as the number `YYYYMMDD`; only these 8-digit dates are kept. */
const DATE = /^\d{8}$/;

function parseDate(text: string | undefined): number | null {
  const trimmed = text?.trim();
  return trimmed !== undefined && DATE.test(trimmed) ? Number(trimmed) : null;
}

interface Weekly {
  /** Monday first. */
  readonly days: readonly boolean[];
  readonly startDate: number;
  readonly endDate: number;
}

interface Exceptions {
  readonly added: Set<number>;
  readonly removed: Set<number>;
}

/**
 * Which services operate on which service dates: the weekly pattern of `calendar.txt` (weekday
 * flag set, date within `start_date`..`end_date` inclusive), then the `calendar_dates.txt`
 * exceptions on top (type 1 adds the date, type 2 removes it). A service only in
 * `calendar_dates.txt` operates exactly on its type 1 dates. A date with both exceptions counts
 * as added.
 */
export class ServiceCalendar {
  readonly #weekly = new Map<string, Weekly>();
  readonly #exceptions = new Map<string, Exceptions>();

  /**
   * Records a `calendar.txt` row. Returns the service id when it is new (its string is now
   * retained), else null; a row without a service id, or whose `start_date` or `end_date` is not
   * `YYYYMMDD`, is ignored (that service then only operates on its added dates).
   */
  addWeekly(row: Row): string | null {
    const serviceId = row['service_id'];
    const startDate = parseDate(row['start_date']);
    const endDate = parseDate(row['end_date']);
    if (!serviceId || startDate === null || endDate === null || this.#weekly.has(serviceId)) {
      return null;
    }
    this.#weekly.set(serviceId, {
      days: WEEKDAY_COLUMNS.map((column) => row[column]?.trim() === '1'),
      startDate,
      endDate,
    });
    return serviceId;
  }

  /**
   * Records a `calendar_dates.txt` row. Returns what is newly retained: the service id's string
   * when its first exception is recorded, and whether a date was kept. Rows with an unknown
   * exception type, no service id or a date that is not `YYYYMMDD` are ignored.
   */
  addException(row: Row): { newServiceId: string | null; kept: boolean } {
    const serviceId = row['service_id'];
    const date = parseDate(row['date']);
    const type = row['exception_type']?.trim();
    if (!serviceId || date === null || (type !== '1' && type !== '2')) {
      return { newServiceId: null, kept: false };
    }
    let exceptions = this.#exceptions.get(serviceId);
    const newServiceId = exceptions ? null : serviceId;
    if (!exceptions) {
      exceptions = { added: new Set(), removed: new Set() };
      this.#exceptions.set(serviceId, exceptions);
    }
    (type === '1' ? exceptions.added : exceptions.removed).add(date);
    return { newServiceId, kept: true };
  }

  /** `date` is a service date, `YYYYMMDD`. */
  operatesOn(serviceId: string, serviceDate: string): boolean {
    const date = parseDate(serviceDate);
    if (date === null) return false;
    const exceptions = this.#exceptions.get(serviceId);
    if (exceptions?.added.has(date)) return true;
    if (exceptions?.removed.has(date)) return false;
    const weekly = this.#weekly.get(serviceId);
    if (!weekly || date < weekly.startDate || date > weekly.endDate) return false;
    const year = Math.floor(date / 10_000);
    const month = Math.floor(date / 100) % 100;
    const day = date % 100;
    const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return weekly.days[(sundayFirst + 6) % 7] ?? false;
  }
}
