import { ServiceCalendar } from './calendar.js';
import { readCsv } from './csv.js';
import type { ChunkedBody } from './download.js';
import { ScheduleLoadError } from './errors.js';
import type { LoadGuard } from './guard.js';
import type { MemoryBudget } from './memory.js';
import { rowBytes, stringBytes } from './memory.js';
import { MemoryScheduleStore } from './memory-store.js';
import { readFrequencyRow, tooDense } from './frequency.js';
import { encodeShapes } from './shapes.js';
import type { Row, ScheduleConfigurationError, ScheduleStore, TripTemplate } from './store.js';
import { parseGtfsTime } from './time.js';
import { ZipArchive } from './zip.js';

const ALWAYS_REQUIRED = ['agency.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;

/** The files that are read; every other entry of the archive is ignored. */
const READ_FILES: ReadonlySet<string> = new Set([
  ...ALWAYS_REQUIRED,
  'calendar.txt',
  'calendar_dates.txt',
  'frequencies.txt',
  'shapes.txt',
]);

/** Per-entry estimates (bytes) for what the row sizes do not cover. */
const MAP_SLOT_BYTES = 64;
const TRIP_BYTES = 96;
const ARRAY_SLOT_BYTES = 8;
const EMPTY_ARRAY_BYTES = 32;
/** A service's weekly pattern (the object and its seven flags), excluding its id string. */
const WEEKLY_SERVICE_BYTES = 240;
/** One exception date in a set. */
const EXCEPTION_DATE_BYTES = 48;
/** A service's two exception sets and their map slot, excluding its id string. */
const EXCEPTION_SERVICE_BYTES = 200;
/** A trip's first/last stop accumulator (an object of six numbers) and its map slot. */
const STOP_ACCUMULATOR_BYTES = 200;
const TEMPLATE_BYTES = 32;

/** The frequency rows of a trip that has none: shared, never pushed to. */
const NO_ROWS: Row[] = [];

interface MutableTrip {
  id: string;
  row: Row;
  template: TripTemplate | null;
  frequencies: Row[];
}

/** The first and last stop seen so far for a trip, by `stop_sequence` (stop_times.txt may be unsorted). */
interface StopTimes {
  firstSeq: number;
  /** The stop's departure, else its arrival, in seconds; null if neither is usable. */
  start: number | null;
  lastSeq: number;
  /** The stop's arrival, else its departure, in seconds; null if neither is usable. */
  end: number | null;
}

function checkRequiredFiles(archive: ZipArchive): void {
  for (const name of ALWAYS_REQUIRED) {
    if (!archive.has(name)) {
      throw new ScheduleLoadError('missing_file', `${name} is missing from the schedule.`);
    }
  }
  if (!archive.has('calendar.txt') && !archive.has('calendar_dates.txt')) {
    throw new ScheduleLoadError(
      'missing_file',
      'Neither calendar.txt nor calendar_dates.txt is in the schedule; one is required.',
    );
  }
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

async function readAgency(
  archive: ZipArchive,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<{ names: string[]; timezone: string }> {
  const names: string[] = [];
  let timezone: string | null = null;
  for await (const row of readCsv(
    archive,
    'agency.txt',
    ['agency_name', 'agency_timezone'],
    guard,
  )) {
    const name = row['agency_name'] ?? '';
    budget.add(stringBytes(name) + ARRAY_SLOT_BYTES);
    names.push(name);
    timezone ??= row['agency_timezone']?.trim() ?? '';
  }
  if (timezone === null) {
    throw new ScheduleLoadError('invalid_schedule', 'agency.txt has no rows.');
  }
  if (!validTimezone(timezone)) {
    throw new ScheduleLoadError(
      'invalid_schedule',
      'agency.txt has no valid agency_timezone in its first row.',
    );
  }
  return { names, timezone };
}

async function readRoutes(
  archive: ZipArchive,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<Map<string, Row>> {
  const routes = new Map<string, Row>();
  for await (const row of readCsv(archive, 'routes.txt', ['route_id'], guard)) {
    const id = row['route_id'];
    if (!id || routes.has(id)) continue;
    budget.add(rowBytes(row) + stringBytes(id) + MAP_SLOT_BYTES);
    routes.set(id, row);
  }
  return routes;
}

async function readTrips(
  archive: ZipArchive,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<Map<string, MutableTrip>> {
  const trips = new Map<string, MutableTrip>();
  for await (const row of readCsv(archive, 'trips.txt', ['trip_id', 'service_id'], guard)) {
    const id = row['trip_id'];
    if (!id || trips.has(id)) continue;
    budget.add(rowBytes(row) + stringBytes(id) + MAP_SLOT_BYTES + TRIP_BYTES);
    trips.set(id, { id, row, template: null, frequencies: NO_ROWS });
  }
  return trips;
}

async function readCalendar(
  archive: ZipArchive,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<ServiceCalendar> {
  const calendar = new ServiceCalendar();
  if (archive.has('calendar.txt')) {
    const required = ['service_id', 'start_date', 'end_date'];
    for await (const row of readCsv(archive, 'calendar.txt', required, guard)) {
      const serviceId = calendar.addWeekly(row);
      if (serviceId !== null) budget.add(WEEKLY_SERVICE_BYTES + stringBytes(serviceId));
    }
  }
  if (archive.has('calendar_dates.txt')) {
    const required = ['service_id', 'date', 'exception_type'];
    for await (const row of readCsv(archive, 'calendar_dates.txt', required, guard)) {
      const { newServiceId, kept } = calendar.addException(row);
      if (newServiceId !== null) {
        budget.add(EXCEPTION_SERVICE_BYTES + stringBytes(newServiceId));
      }
      if (kept) budget.add(EXCEPTION_DATE_BYTES);
    }
  }
  return calendar;
}

/** Attaches each known trip's `frequencies.txt` rows, whole; rows of unknown trips are dropped. */
async function readFrequencies(
  archive: ZipArchive,
  trips: Map<string, MutableTrip>,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<void> {
  if (!archive.has('frequencies.txt')) return;
  for await (const row of readCsv(archive, 'frequencies.txt', ['trip_id'], guard)) {
    const trip = trips.get(row['trip_id'] ?? '');
    if (!trip) continue;
    if (trip.frequencies === NO_ROWS) {
      budget.add(EMPTY_ARRAY_BYTES);
      trip.frequencies = [];
    }
    budget.add(rowBytes(row) + ARRAY_SLOT_BYTES);
    trip.frequencies.push(row);
  }
}

/**
 * The configuration errors of the trips (trip-activity.md "Schedule entries"), in `trips.txt`
 * order, a trip with several problems under each code in this order: `mixed_exact_times`,
 * `unusable_stop_times`, `frequency_too_dense`.
 */
function configurationErrors(trips: Iterable<MutableTrip>): ScheduleConfigurationError[] {
  const errors: ScheduleConfigurationError[] = [];
  for (const trip of trips) {
    if (trip.frequencies.length > 1) {
      const values = new Set(trip.frequencies.map((row) => row['exact_times']?.trim() || '0'));
      if (values.size > 1) errors.push({ code: 'mixed_exact_times', tripId: trip.id });
    }
    if (trip.template === null) errors.push({ code: 'unusable_stop_times', tripId: trip.id });
    else if (trip.frequencies.length > 0) {
      const duration = trip.template.endSecs - trip.template.startSecs;
      const dense = trip.frequencies.some((row) => {
        const { startSecs, endSecs, headwaySecs } = readFrequencyRow(row);
        return (
          startSecs !== null &&
          endSecs !== null &&
          headwaySecs !== null &&
          tooDense(duration, headwaySecs)
        );
      });
      if (dense) errors.push({ code: 'frequency_too_dense', tripId: trip.id });
    }
  }
  return errors;
}

const SEQUENCE = /^\d+$/;

/** A `stop_sequence`: a non-negative integer in plain digits, else null. */
function parseSequence(text: string | undefined): number | null {
  const trimmed = text?.trim();
  return trimmed !== undefined && SEQUENCE.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Keeps, for each known trip, only its first and last stop time (by `stop_sequence`) as numbers
 * and turns them into the template; every other `stop_times.txt` row, and the text of the times,
 * is discarded as it streams by.
 */
async function readTemplates(
  archive: ZipArchive,
  trips: Map<string, MutableTrip>,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<void> {
  const seen = new Map<string, StopTimes>();
  const columns = ['trip_id', 'stop_sequence'];
  for await (const row of readCsv(archive, 'stop_times.txt', columns, guard)) {
    const trip = trips.get(row['trip_id'] ?? '');
    if (!trip) continue;
    const seq = parseSequence(row['stop_sequence']);
    if (seq === null) continue;
    const arrival = () => parseGtfsTime(row['arrival_time']);
    const departure = () => parseGtfsTime(row['departure_time']);
    const stop = seen.get(trip.id);
    if (!stop) {
      budget.add(STOP_ACCUMULATOR_BYTES);
      seen.set(trip.id, {
        firstSeq: seq,
        start: departure() ?? arrival(),
        lastSeq: seq,
        end: arrival() ?? departure(),
      });
      continue;
    }
    if (seq < stop.firstSeq) {
      stop.firstSeq = seq;
      stop.start = departure() ?? arrival();
    }
    if (seq > stop.lastSeq) {
      stop.lastSeq = seq;
      stop.end = arrival() ?? departure();
    }
  }
  for (const [id, { start, end }] of seen) {
    trips.get(id)!.template =
      start === null || end === null ? null : { startSecs: start, endSecs: end };
    budget.release(STOP_ACCUMULATOR_BYTES);
    budget.add(TEMPLATE_BYTES);
  }
}

/**
 * Reduces a downloaded GTFS Schedule zip to the retained data (feed-ingest.md "Schedule"),
 * streaming every file and charging what it keeps to `budget`.
 *
 * Throws `ScheduleLoadError`: `bad_zip`, `missing_file` (names the file), `bad_csv`,
 * `invalid_schedule` (a required column or the agency timezone is missing), `too_large`
 * (the memory limit, or more inflated bytes than the guard allows), `timeout` (the guard's
 * deadline) or `aborted`.
 */
export async function parseSchedule(
  body: ChunkedBody,
  budget: MemoryBudget,
  guard: LoadGuard,
): Promise<ScheduleStore> {
  const archive = await ZipArchive.open(body, READ_FILES);
  try {
    checkRequiredFiles(archive);
    const agency = await readAgency(archive, budget, guard);
    const routes = await readRoutes(archive, budget, guard);
    const trips = await readTrips(archive, budget, guard);
    const calendar = await readCalendar(archive, budget, guard);
    await readFrequencies(archive, trips, budget, guard);
    await readTemplates(archive, trips, budget, guard);
    const shapes = archive.has('shapes.txt')
      ? await encodeShapes(
          () =>
            readCsv(
              archive,
              'shapes.txt',
              ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
              guard,
            ),
          budget,
        )
      : new Map<string, string>();
    return new MemoryScheduleStore({
      agency,
      routes,
      trips,
      calendar,
      shapes,
      configurationErrors: configurationErrors(trips.values()),
      estimatedBytes: budget.used,
    });
  } finally {
    archive.close();
  }
}
