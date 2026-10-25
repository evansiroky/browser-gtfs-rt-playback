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

interface Weekly {
  /** Monday first. */
  readonly days: readonly boolean[];
  readonly startDate: string;
  readonly endDate: string;
}

interface Exceptions {
  readonly added: Set<string>;
  readonly removed: Set<string>;
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

  addWeekly(row: Row): void {
    const serviceId = row['service_id'];
    if (!serviceId || this.#weekly.has(serviceId)) return;
    this.#weekly.set(serviceId, {
      days: WEEKDAY_COLUMNS.map((column) => row[column]?.trim() === '1'),
      startDate: row['start_date']?.trim() ?? '',
      endDate: row['end_date']?.trim() ?? '',
    });
  }

  addException(row: Row): void {
    const serviceId = row['service_id'];
    const date = row['date']?.trim();
    const type = row['exception_type']?.trim();
    if (!serviceId || !date || (type !== '1' && type !== '2')) return;
    let exceptions = this.#exceptions.get(serviceId);
    if (!exceptions) {
      exceptions = { added: new Set(), removed: new Set() };
      this.#exceptions.set(serviceId, exceptions);
    }
    (type === '1' ? exceptions.added : exceptions.removed).add(date);
  }

  /** `date` is a service date, `YYYYMMDD`. */
  operatesOn(serviceId: string, date: string): boolean {
    const exceptions = this.#exceptions.get(serviceId);
    if (exceptions?.added.has(date)) return true;
    if (exceptions?.removed.has(date)) return false;
    const weekly = this.#weekly.get(serviceId);
    if (!weekly || date < weekly.startDate || date > weekly.endDate) return false;
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return weekly.days[(sundayFirst + 6) % 7] ?? false;
  }
}
