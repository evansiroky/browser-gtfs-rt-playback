import type { ConfigurationErrorCode } from '@gtfs-rt-debugger/shared';
import { readFrequencyRow } from '../schedule/frequency.js';
import type { Row, ScheduleStore, ScheduleTrip } from '../schedule/store.js';
import { addDays, agencyDate, serviceDayStart } from './time.js';

/** What a `frequencies.txt` row says; the values are null where the row cannot be read. */
export interface FrequencyRowInfo {
  /** Position of the row among the trip's `frequencies.txt` rows. */
  readonly rowIndex: number;
  readonly row: Row;
  /** Seconds from the service day start. */
  readonly startSecs: number | null;
  readonly endSecs: number | null;
  readonly headwaySecs: number | null;
  /** As sent (absent = false); informational only. */
  readonly exactTimes: boolean;
  /** The number of nominal instances: 0 for a row that cannot be read or has an empty window. */
  readonly count: number;
}

/**
 * A readable row (trip-activity.md "Schedule entries"): instances start at `startSecs`,
 * `startSecs + headwaySecs`, ... while before `endSecs`.
 */
export interface FrequencyWindow extends FrequencyRowInfo {
  readonly startSecs: number;
  readonly endSecs: number;
  readonly headwaySecs: number;
}

/** Every row of a trip, readable or not, in file order. */
export function parseFrequencyRows(rows: readonly Row[]): FrequencyRowInfo[] {
  return rows.map((row, rowIndex) => {
    const { startSecs, endSecs, headwaySecs } = readFrequencyRow(row);
    const readable = startSecs !== null && endSecs !== null && headwaySecs !== null;
    return {
      rowIndex,
      row,
      startSecs,
      endSecs,
      headwaySecs,
      exactTimes: row['exact_times']?.trim() === '1',
      count: readable && endSecs > startSecs ? Math.ceil((endSecs - startSecs) / headwaySecs) : 0,
    };
  });
}

/** The rows that can be read. */
export function readableWindows(rows: readonly Row[]): FrequencyWindow[] {
  return parseFrequencyRows(rows).filter(
    (info): info is FrequencyWindow =>
      info.startSecs !== null && info.endSecs !== null && info.headwaySecs !== null,
  );
}

/**
 * A schedule entry (trip-activity.md): a plain trip, or one nominal instance of a frequency row.
 * A plain trip is identified by its trip ID, an instance by its trip ID and start instant.
 */
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
  /**
   * Whether the entries of the trip can repeat: rows with overlapping windows, or instances far
   * enough apart that one date's start instants can be another's. Such trips are enumerated
   * and de-duplicated; the others are counted by arithmetic.
   */
  readonly exact: boolean;
}

/** A day is at least this many seconds (a day with a one-hour change has 23 hours). */
const SHORTEST_DAY_SECS = 82_800;

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
        exact: false,
      },
    ];
  }
  const windows = readableWindows(trip.frequencies).filter((window) => window.count > 0);
  const exact = repeats(windows);
  return windows.map((window) => {
    const lastStart = window.startSecs + (window.count - 1) * window.headwaySecs;
    return {
      trip,
      window,
      durationSecs: duration,
      lo: Math.min(window.startSecs, window.startSecs + duration),
      hi: Math.max(lastStart, lastStart + duration),
      exact,
    };
  });
}

/** Whether the instants of these windows can repeat (see {@link Item.exact}). */
function repeats(windows: readonly FrequencyWindow[]): boolean {
  if (windows.length === 0) return false;
  const byStart = [...windows].sort((a, b) => a.startSecs - b.startSecs);
  let furthest = -Infinity;
  let first = Infinity;
  let last = -Infinity;
  for (const window of byStart) {
    if (window.startSecs < furthest) return true;
    furthest = Math.max(furthest, window.endSecs);
    first = Math.min(first, window.startSecs);
    last = Math.max(last, window.startSecs + (window.count - 1) * window.headwaySecs);
  }
  return last - first >= SHORTEST_DAY_SECS;
}

/** The start offsets of the active instances of an item, `a` seconds into the service day. */
function activeRange(item: Item, a: number): { first: number; last: number } | null {
  if (!item.window) {
    const { startSecs, endSecs } = item.trip.template!;
    return startSecs <= a + 59 && endSecs >= a ? { first: 0, last: 0 } : null;
  }
  const { startSecs, headwaySecs, count } = item.window;
  const first = Math.max(0, Math.ceil((a - item.durationSecs - startSecs) / headwaySecs));
  const last = Math.min(count - 1, Math.floor((a + 59 - startSecs) / headwaySecs));
  return first <= last ? { first, last } : null;
}

function spanOf(item: Item, k: number): Span {
  if (!item.window) return item.trip.template!;
  const startSecs = item.window.startSecs + k * item.window.headwaySecs;
  return { startSecs, endSecs: startSecs + item.durationSecs };
}

const BLOCK = 128;

const indexes = new WeakMap<ScheduleStore, ScheduleIndex>();

/**
 * What can be known about the schedule without a clock: the items ordered by start second, the
 * entries produced per service, the configuration errors per trip. It is a pure function of the
 * immutable store and lives only as long as the store does (the loader drops both at dormancy);
 * which entries are scheduled or active, and on which date, is always computed from the clock.
 */
export class ScheduleIndex {
  /** Configuration error codes per trip ID, in the store's order. */
  readonly errors = new Map<string, ConfigurationErrorCode[]>();
  /** Entries produced by one service day, per service ID. */
  readonly entriesPerService = new Map<string, number>();
  /** The trips whose entries can repeat, counted by enumeration. */
  readonly exactTrips: ScheduleTrip[] = [];
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
      const items = itemsOf(trip);
      if (items.length === 0) continue;
      for (const item of items) this.#items.push(item);
      const serviceId = trip.row['service_id'];
      if (!serviceId) continue;
      if (items[0]!.exact) this.exactTrips.push(trip);
      this.entriesPerService.set(
        serviceId,
        (this.entriesPerService.get(serviceId) ?? 0) + entriesPerDay(items),
      );
    }
    this.#items.sort((a, b) => a.lo - b.lo);
    this.#blockHi = new Float64Array(Math.ceil(this.#items.length / BLOCK)).fill(-Infinity);
    this.#items.forEach((item, i) => {
      const block = Math.floor(i / BLOCK);
      this.#blockHi[block] = Math.max(this.#blockHi[block]!, item.hi);
    });
  }

  /** The items with an active instance `a` seconds into a service day, and which instances. */
  *active(a: number): Generator<{ item: Item; first: number; last: number }> {
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
      const range = activeRange(item, a);
      if (range) yield { item, ...range };
    }
  }
}

/** The entries one service day produces for a trip: instances at one instant count once. */
function entriesPerDay(items: readonly Item[]): number {
  if (items[0]!.window === null) return 1;
  let total = 0;
  for (const item of items) total += item.window!.count;
  const windows = items.map((item) => item.window!);
  // Only rows whose windows overlap can produce an instant twice.
  const byStart = [...windows].sort((a, b) => a.startSecs - b.startSecs);
  let furthest = -Infinity;
  let overlapping = false;
  for (const window of byStart) {
    if (window.startSecs < furthest) overlapping = true;
    furthest = Math.max(furthest, window.endSecs);
  }
  if (!overlapping) return total;
  const starts = new Set<number>();
  for (const window of windows) {
    for (let k = 0; k < window.count; k++) starts.add(window.startSecs + k * window.headwaySecs);
  }
  return starts.size;
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
  readonly #trips = new Map<string, { serviceId: string | undefined; frequency: boolean } | null>();
  readonly #tripEntries = new Map<string, readonly Entry[]>();

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

  /** What a reference needs to know of its trip, looked up once per trip per computation. */
  tripFacts(tripId: string): { serviceId: string | undefined; frequency: boolean } | null {
    let facts = this.#trips.get(tripId);
    if (facts === undefined) {
      const row = this.store.trip(tripId);
      facts = row
        ? { serviceId: row['service_id'], frequency: this.store.frequencies(tripId).length > 0 }
        : null;
      this.#trips.set(tripId, facts);
    }
    return facts;
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

  /** The active entries of one trip, memoized for this computation. */
  tripEntries(tripId: string): readonly Entry[] {
    let entries = this.#tripEntries.get(tripId);
    if (!entries) {
      const trip = tripOf(this.store, tripId);
      entries =
        !trip || this.index.errors.has(tripId) ? [] : collect(this, itemsOf(trip), trip.row);
      this.#tripEntries.set(tripId, entries);
    }
    return entries;
  }
}

/** Seconds into the service day of `date` at which the current minute starts. */
const secondsIn = (frame: Frame, date: string): number => frame.minute - frame.dayStart(date);

/**
 * The active entries of the items of one trip. A plain trip is one entry, on the later date it is
 * active; an instance is identified by its start instant, so one produced twice is one entry, on
 * the later date, described by the first row.
 */
function collect(frame: Frame, items: readonly Item[], row: Row): Entry[] {
  const entries = new Map<string, Entry>();
  for (const date of frame.candidates) {
    if (!frame.operates(row['service_id'], date)) continue;
    const a = secondsIn(frame, date);
    for (const item of items) {
      const range = activeRange(item, a);
      if (range) addInstances(frame, entries, item, date, range);
    }
  }
  return [...entries.values()];
}

function addInstances(
  frame: Frame,
  entries: Map<string, Entry>,
  item: Item,
  date: string,
  { first, last }: { first: number; last: number },
): void {
  for (let k = first; k <= last; k++) {
    const entry = frame.entry(item.trip.id, date, spanOf(item, k), item.window);
    const key = item.window ? `${item.trip.id}\0${entry.start}` : item.trip.id;
    const previous = entries.get(key);
    // On one date the first row in the file describes an instant; a later date replaces an earlier.
    if (
      previous?.window &&
      item.window &&
      previous.date === date &&
      previous.window.rowIndex <= item.window.rowIndex
    ) {
      continue;
    }
    entries.set(key, entry);
  }
}

/** Every active entry of the candidate service dates (trip-activity.md "Counts"). */
export function activeEntries(frame: Frame): Entry[] {
  const entries = new Map<string, Entry>();
  for (const date of frame.candidates) {
    for (const { item, first, last } of frame.index.active(secondsIn(frame, date))) {
      if (frame.operates(item.trip.row['service_id'], date)) {
        addInstances(frame, entries, item, date, { first, last });
      }
    }
  }
  return [...entries.values()];
}

/**
 * The number of active entries, without making one: a plain trip counts once whichever dates it
 * is active on, the instances of other trips are counted by arithmetic, and only trips whose
 * entries can repeat are enumerated.
 */
export function countActive(frame: Frame): number {
  let total = 0;
  const plain = new Set<string>();
  for (const date of frame.candidates) {
    for (const { item, first, last } of frame.index.active(secondsIn(frame, date))) {
      if (item.exact || !frame.operates(item.trip.row['service_id'], date)) continue;
      if (item.window) total += last - first + 1;
      else if (!plain.has(item.trip.id)) {
        plain.add(item.trip.id);
        total++;
      }
    }
  }
  for (const trip of frame.index.exactTrips) total += frame.tripEntries(trip.id).length;
  return total;
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
 * frequency instance), or the trip's only entry when it is a plain trip. Null when the trip has
 * no such entry, or none at all because of a configuration error.
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
  for (const window of readableWindows(trip.frequencies)) {
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
  for (const window of readableWindows(trip.frequencies)) {
    if (window.count === 0) continue;
    const lastStart = window.startSecs + (window.count - 1) * window.headwaySecs;
    start = Math.min(start, window.startSecs);
    end = Math.max(end, lastStart + duration);
  }
  return start === Infinity ? null : { start: dayStart + start, end: dayStart + end };
}

export function configurationErrorMessage(code: ConfigurationErrorCode): string {
  switch (code) {
    case 'mixed_exact_times':
      return "The trip's frequencies.txt rows do not all have the same exact_times value, so its activity cannot be determined.";
    case 'unusable_stop_times':
      return 'The start or end of the trip cannot be computed from its stop_times.txt rows (no rows, or no time at the first or last stop), so its activity cannot be determined.';
    case 'frequency_too_dense':
      return 'A frequencies.txt row of the trip could have more than 2,000 instances running at once (its headway is too short for the length of its stop times), so its activity is not determined.';
  }
}
