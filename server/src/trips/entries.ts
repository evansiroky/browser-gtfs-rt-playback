import type { ConfigurationErrorCode } from '@gtfs-rt-debugger/shared';
import { parseGtfsTime } from '../schedule/time.js';
import type { Row, ScheduleStore, ScheduleTrip } from '../schedule/store.js';
import { addDays, agencyDate, serviceDayStart } from './time.js';

/**
 * One interpretable `frequencies.txt` row of a trip (trip-activity.md "Schedule entries"): the
 * nominal instances start at `startSecs`, `startSecs + headwaySecs`, ... while before `endSecs`.
 */
export interface FrequencyWindow {
  /** Position of the row among the trip's `frequencies.txt` rows. */
  readonly rowIndex: number;
  readonly row: Row;
  /** Seconds from the service day start. */
  readonly startSecs: number;
  readonly endSecs: number;
  readonly headwaySecs: number;
  /** As sent (absent = false); informational only. */
  readonly exactTimes: boolean;
  /** The number of instances. */
  readonly count: number;
}

/** The rows that can be interpreted; the others produce no instances. */
export function parseFrequencyRows(rows: readonly Row[]): FrequencyWindow[] {
  const windows: FrequencyWindow[] = [];
  rows.forEach((row, rowIndex) => {
    const startSecs = parseGtfsTime(row['start_time']);
    const endSecs = parseGtfsTime(row['end_time']);
    const headway = /^\s*\d+\s*$/.test(row['headway_secs'] ?? '') ? Number(row['headway_secs']) : 0;
    if (startSecs === null || endSecs === null || headway <= 0) return;
    windows.push({
      rowIndex,
      row,
      startSecs,
      endSecs,
      headwaySecs: headway,
      exactTimes: row['exact_times']?.trim() === '1',
      count: endSecs > startSecs ? Math.ceil((endSecs - startSecs) / headway) : 0,
    });
  });
  return windows;
}

/** A schedule entry (trip-activity.md): a plain trip, or one nominal instance of a frequency row. */
export interface Entry {
  readonly tripId: string;
  /** The service date the entry is on. */
  readonly date: string;
  /** Epoch seconds. */
  readonly start: number;
  readonly end: number;
  /** The row the entry is an instance of; null for a plain trip. */
  readonly window: FrequencyWindow | null;
  /** Epoch seconds of the service day start of `date`. */
  readonly dayStart: number;
}

/** A trip's seconds from the service day start to its start and end instants. */
interface Span {
  readonly startSecs: number;
  readonly endSecs: number;
}

/** What a trip contributes to a service day: a plain span, or the series of a frequency row. */
interface Item {
  readonly trip: ScheduleTrip;
  readonly window: FrequencyWindow | null;
  /** Template duration: the span of a frequency instance. */
  readonly durationSecs: number;
  /** Lowest and highest second any instance of the item touches. */
  readonly lo: number;
  readonly hi: number;
}

/** The items of a trip that has no configuration error. */
function itemsOf(trip: ScheduleTrip): Item[] {
  const template = trip.template;
  if (!template) return [];
  const duration = template.endSecs - template.startSecs;
  if (trip.frequencies.length === 0) {
    return [
      {
        trip,
        window: null,
        durationSecs: duration,
        lo: Math.min(template.startSecs, template.endSecs),
        hi: Math.max(template.startSecs, template.endSecs),
      },
    ];
  }
  return parseFrequencyRows(trip.frequencies)
    .filter((window) => window.count > 0)
    .map((window) => {
      const lastStart = window.startSecs + (window.count - 1) * window.headwaySecs;
      return {
        trip,
        window,
        durationSecs: duration,
        lo: Math.min(window.startSecs, window.startSecs + duration),
        hi: Math.max(lastStart, lastStart + duration),
      };
    });
}

/** Offsets (seconds from the day start) of the instances of an item overlapping `[a, a + 59]`. */
function activeOffsets(item: Item, a: number): Span[] {
  if (!item.window) {
    const startSecs = item.trip.template!.startSecs;
    const endSecs = item.trip.template!.endSecs;
    return startSecs <= a + 59 && endSecs >= a ? [{ startSecs, endSecs }] : [];
  }
  const { startSecs, headwaySecs, count } = item.window;
  const first = Math.max(0, Math.ceil((a - item.durationSecs - startSecs) / headwaySecs));
  const last = Math.min(count - 1, Math.floor((a + 59 - startSecs) / headwaySecs));
  const spans: Span[] = [];
  for (let k = first; k <= last; k++) {
    const start = startSecs + k * headwaySecs;
    spans.push({ startSecs: start, endSecs: start + item.durationSecs });
  }
  return spans;
}

const BLOCK = 128;

const indexes = new WeakMap<ScheduleStore, ScheduleIndex>();

/**
 * What can be known about the schedule without a clock: the entries by start second, the
 * entries produced per service, the configuration errors per trip. It is a pure function of the
 * immutable store and lives only as long as the store does (the loader drops both at dormancy);
 * which entries are scheduled or active, and on which date, is always computed from the clock.
 */
export class ScheduleIndex {
  /** Configuration error codes per trip ID, in the store's order. */
  readonly errors = new Map<string, ConfigurationErrorCode[]>();
  /** Entries produced by one service day, per service ID. */
  readonly entriesPerService = new Map<string, number>();
  readonly #items: Item[] = [];
  /** The highest `hi` of each block of {@link BLOCK} items, so a query skips finished blocks. */
  readonly #blockHi: Float64Array;

  static of(store: ScheduleStore): ScheduleIndex {
    let index = indexes.get(store);
    if (!index) {
      index = new ScheduleIndex(store);
      indexes.set(store, index);
    }
    return index;
  }

  private constructor(store: ScheduleStore) {
    for (const { code, tripId } of store.configurationErrors()) {
      const codes = this.errors.get(tripId);
      if (codes) codes.push(code);
      else this.errors.set(tripId, [code]);
    }
    for (const trip of store.trips()) {
      if (this.errors.has(trip.id)) continue;
      for (const item of itemsOf(trip)) {
        this.#items.push(item);
        const serviceId = trip.row['service_id'];
        if (serviceId) {
          this.entriesPerService.set(
            serviceId,
            (this.entriesPerService.get(serviceId) ?? 0) + (item.window?.count ?? 1),
          );
        }
      }
    }
    this.#items.sort((a, b) => a.lo - b.lo);
    this.#blockHi = new Float64Array(Math.ceil(this.#items.length / BLOCK)).fill(-Infinity);
    this.#items.forEach((item, i) => {
      const block = Math.floor(i / BLOCK);
      this.#blockHi[block] = Math.max(this.#blockHi[block]!, item.hi);
    });
  }

  /** The active instances at `a` seconds into a service day, for every item of every service. */
  *active(a: number): Generator<{ item: Item; span: Span }> {
    let low = 0;
    for (let high = this.#items.length; low < high;) {
      const middle = (low + high) >> 1;
      if (this.#items[middle]!.lo <= a + 59) low = middle + 1;
      else high = middle;
    }
    // Items before `low` start early enough; skip blocks that all ended before the minute.
    for (let i = 0; i < low; i++) {
      if (i % BLOCK === 0 && this.#blockHi[i / BLOCK]! < a) {
        i += BLOCK - 1;
        continue;
      }
      const item = this.#items[i]!;
      if (item.hi < a) continue;
      for (const span of activeOffsets(item, a)) yield { item, span };
    }
  }
}

/** The clock of one computation: the candidate service dates and the current minute. */
export class Frame {
  readonly minute: number;
  readonly today: string;
  readonly yesterday: string;
  /** Yesterday, then today: the later date wins every tie. */
  readonly candidates: readonly [string, string];
  readonly index: ScheduleIndex;
  readonly timeZone: string;
  readonly #dayStarts = new Map<string, number>();
  readonly #operates = new Map<string, boolean>();

  constructor(
    readonly store: ScheduleStore,
    readonly nowMs: number,
  ) {
    this.timeZone = store.agency().timezone;
    this.minute = Math.floor(nowMs / 60_000) * 60;
    this.today = agencyDate(nowMs, this.timeZone);
    this.yesterday = addDays(this.today, -1);
    this.candidates = [this.yesterday, this.today];
    this.index = ScheduleIndex.of(store);
  }

  /** Epoch seconds GTFS times on `date` count from. */
  dayStart(date: string): number {
    let start = this.#dayStarts.get(date);
    if (start === undefined) {
      start = serviceDayStart(date, this.timeZone);
      this.#dayStarts.set(date, start);
    }
    return start;
  }

  operates(serviceId: string | undefined, date: string): boolean {
    if (!serviceId) return false;
    const key = `${serviceId}\0${date}`;
    let result = this.#operates.get(key);
    if (result === undefined) {
      result = this.store.operatesOn(serviceId, date);
      this.#operates.set(key, result);
    }
    return result;
  }

  entry(tripId: string, date: string, span: Span, window: FrequencyWindow | null): Entry {
    const dayStart = this.dayStart(date);
    return {
      tripId,
      date,
      start: dayStart + span.startSecs,
      end: dayStart + span.endSecs,
      window,
      dayStart,
    };
  }
}

/** Seconds into the service day of `date` at which the current minute starts. */
const secondsIn = (frame: Frame, date: string): number => frame.minute - frame.dayStart(date);

/**
 * The active entries of the candidate service dates (trip-activity.md "Counts"): entries on a
 * date their trip operates, overlapping the current minute. An entry active on both dates is
 * on the later one.
 */
export function activeEntries(frame: Frame): Entry[] {
  const entries = new Map<string, Entry>();
  for (const date of frame.candidates) {
    for (const { item, span } of frame.index.active(secondsIn(frame, date))) {
      if (!frame.operates(item.trip.row['service_id'], date)) continue;
      const key = `${item.trip.id}\0${item.window?.rowIndex ?? -1}\0${span.startSecs}`;
      entries.set(key, frame.entry(item.trip.id, date, span, item.window));
    }
  }
  return [...entries.values()];
}

/** The active entries of one trip, as {@link activeEntries} would hold them. */
export function activeEntriesOf(frame: Frame, tripId: string): Entry[] {
  const trip = tripOf(frame.store, tripId);
  if (!trip || frame.index.errors.has(tripId)) return [];
  const entries = new Map<string, Entry>();
  for (const date of frame.candidates) {
    if (!frame.operates(trip.row['service_id'], date)) continue;
    for (const item of itemsOf(trip)) {
      for (const span of activeOffsets(item, secondsIn(frame, date))) {
        const key = `${item.window?.rowIndex ?? -1}\0${span.startSecs}`;
        entries.set(key, frame.entry(tripId, date, span, item.window));
      }
    }
  }
  return [...entries.values()];
}

/** The number of entries produced on today's service date. */
export function scheduledToday(frame: Frame): number {
  let total = 0;
  for (const [serviceId, entries] of frame.index.entriesPerService) {
    if (frame.operates(serviceId, frame.today)) total += entries;
  }
  return total;
}

/** The trip as the store holds it, with its template and frequency rows. */
export function tripOf(store: ScheduleStore, tripId: string): ScheduleTrip | undefined {
  const row = store.trip(tripId);
  if (!row) return undefined;
  return {
    id: tripId,
    row,
    template: store.template(tripId),
    frequencies: store.frequencies(tripId),
  };
}

/**
 * The entry of a trip on a service date that starts at `startOffset` seconds into the day (a
 * frequency instance), or the trip's only entry when `startOffset` is null (a plain trip). Null
 * when the trip has no such entry, or none at all because of a configuration error.
 */
export function entryOn(
  frame: Frame,
  trip: ScheduleTrip,
  date: string,
  startOffset: number | null,
): Entry | null {
  if (frame.index.errors.has(trip.id) || !trip.template) return null;
  if (trip.frequencies.length === 0) {
    return frame.entry(trip.id, date, trip.template, null);
  }
  if (startOffset === null) return null;
  const duration = trip.template.endSecs - trip.template.startSecs;
  for (const window of parseFrequencyRows(trip.frequencies)) {
    const since = startOffset - window.startSecs;
    if (since >= 0 && startOffset < window.endSecs && since % window.headwaySecs === 0) {
      return frame.entry(
        trip.id,
        date,
        { startSecs: startOffset, endSecs: startOffset + duration },
        window,
      );
    }
  }
  return null;
}

/** First and last nominal instant of a trip on a service date, or null when it has no entry. */
export function scheduledBounds(
  frame: Frame,
  trip: ScheduleTrip,
  date: string,
): { start: number; end: number } | null {
  if (frame.index.errors.has(trip.id) || !trip.template) return null;
  const dayStart = frame.dayStart(date);
  if (trip.frequencies.length === 0) {
    return { start: dayStart + trip.template.startSecs, end: dayStart + trip.template.endSecs };
  }
  const duration = trip.template.endSecs - trip.template.startSecs;
  let start = Infinity;
  let end = -Infinity;
  for (const window of parseFrequencyRows(trip.frequencies)) {
    if (window.count === 0) continue;
    const lastStart = window.startSecs + (window.count - 1) * window.headwaySecs;
    start = Math.min(start, window.startSecs);
    end = Math.max(end, lastStart + duration);
  }
  return start === Infinity ? null : { start: dayStart + start, end: dayStart + end };
}

export function configurationErrorMessage(code: ConfigurationErrorCode): string {
  return code === 'mixed_exact_times'
    ? "The trip's frequencies.txt rows do not all have the same exact_times value, so its activity cannot be determined."
    : 'The start or end of the trip cannot be computed from its stop_times.txt rows (no rows, or no time at the first or last stop), so its activity cannot be determined.';
}
