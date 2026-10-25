import { ServiceCalendar } from './calendar.js';
import { readCsv } from './csv.js';
import type { ChunkedBody } from './download.js';
import { ScheduleLoadError } from './errors.js';
import type { MemoryBudget } from './memory.js';
import { rowBytes, stringBytes } from './memory.js';
import { MemoryScheduleStore } from './memory-store.js';
import { encodeShapes } from './shapes.js';
import type { Row, ScheduleConfigurationError, ScheduleStore, TripTemplate } from './store.js';
import { parseGtfsTime } from './time.js';
import { ZipArchive } from './zip.js';

const ALWAYS_REQUIRED = ['agency.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'] as const;

/** Per-entry estimates (bytes) for what the row sizes do not cover. */
const MAP_SLOT_BYTES = 64;
const TRIP_BYTES = 96;
const WEEKLY_SERVICE_BYTES = 240;
const EXCEPTION_BYTES = 64;
/** The accumulator object plus the four time strings it holds. */
const STOP_ACCUMULATOR_BYTES = 320;
const TEMPLATE_BYTES = 32;

interface MutableTrip {
  id: string;
  row: Row;
  template: TripTemplate | null;
  frequencies: readonly Row[];
}

/** The first and last stop seen so far for a trip, by `stop_sequence` (stop_times.txt may be unsorted). */
interface StopTimes {
  firstSeq: number;
  firstArrival: string | undefined;
  firstDeparture: string | undefined;
  lastSeq: number;
  lastArrival: string | undefined;
  lastDeparture: string | undefined;
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
  signal: AbortSignal,
): Promise<{ names: string[]; timezone: string }> {
  const names: string[] = [];
  let timezone: string | null = null;
  for await (const row of readCsv(
    archive,
    'agency.txt',
    ['agency_name', 'agency_timezone'],
    signal,
  )) {
    const name = row['agency_name'] ?? '';
    budget.add(stringBytes(name));
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
  signal: AbortSignal,
): Promise<Map<string, Row>> {
  const routes = new Map<string, Row>();
  for await (const row of readCsv(archive, 'routes.txt', ['route_id'], signal)) {
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
  signal: AbortSignal,
): Promise<Map<string, MutableTrip>> {
  const trips = new Map<string, MutableTrip>();
  for await (const row of readCsv(archive, 'trips.txt', ['trip_id', 'service_id'], signal)) {
    const id = row['trip_id'];
    if (!id || trips.has(id)) continue;
    budget.add(rowBytes(row) + stringBytes(id) + MAP_SLOT_BYTES + TRIP_BYTES);
    trips.set(id, { id, row, template: null, frequencies: [] });
  }
  return trips;
}

async function readCalendar(
  archive: ZipArchive,
  budget: MemoryBudget,
  signal: AbortSignal,
): Promise<ServiceCalendar> {
  const calendar = new ServiceCalendar();
  if (archive.has('calendar.txt')) {
    const required = ['service_id', 'start_date', 'end_date'];
    for await (const row of readCsv(archive, 'calendar.txt', required, signal)) {
      budget.add(WEEKLY_SERVICE_BYTES);
      calendar.addWeekly(row);
    }
  }
  if (archive.has('calendar_dates.txt')) {
    const required = ['service_id', 'date', 'exception_type'];
    for await (const row of readCsv(archive, 'calendar_dates.txt', required, signal)) {
      budget.add(EXCEPTION_BYTES);
      calendar.addException(row);
    }
  }
  return calendar;
}

/** Attaches each known trip's `frequencies.txt` rows, whole; rows of unknown trips are dropped. */
async function readFrequencies(
  archive: ZipArchive,
  trips: Map<string, MutableTrip>,
  budget: MemoryBudget,
  signal: AbortSignal,
): Promise<void> {
  if (!archive.has('frequencies.txt')) return;
  for await (const row of readCsv(archive, 'frequencies.txt', ['trip_id'], signal)) {
    const trip = trips.get(row['trip_id'] ?? '');
    if (!trip) continue;
    budget.add(rowBytes(row) + 8);
    trip.frequencies = [...trip.frequencies, row];
  }
}

function configurationErrors(trips: Iterable<MutableTrip>): ScheduleConfigurationError[] {
  const errors: ScheduleConfigurationError[] = [];
  for (const trip of trips) {
    if (trip.frequencies.length < 2) continue;
    const values = new Set(trip.frequencies.map((row) => row['exact_times']?.trim() || '0'));
    if (values.size > 1) errors.push({ code: 'mixed_exact_times', tripId: trip.id });
  }
  return errors;
}

function parseSequence(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) ? value : null;
}

/**
 * Keeps, for each known trip, only its first and last stop time (by `stop_sequence`) and turns
 * them into the template; every other `stop_times.txt` row is discarded as it streams by.
 */
async function readTemplates(
  archive: ZipArchive,
  trips: Map<string, MutableTrip>,
  budget: MemoryBudget,
  signal: AbortSignal,
): Promise<void> {
  const seen = new Map<string, StopTimes>();
  const columns = ['trip_id', 'stop_sequence'];
  for await (const row of readCsv(archive, 'stop_times.txt', columns, signal)) {
    const trip = trips.get(row['trip_id'] ?? '');
    if (!trip) continue;
    const seq = parseSequence(row['stop_sequence']);
    if (seq === null) continue;
    const stop = seen.get(trip.id);
    if (!stop) {
      budget.add(STOP_ACCUMULATOR_BYTES);
      seen.set(trip.id, {
        firstSeq: seq,
        firstArrival: row['arrival_time'],
        firstDeparture: row['departure_time'],
        lastSeq: seq,
        lastArrival: row['arrival_time'],
        lastDeparture: row['departure_time'],
      });
      continue;
    }
    if (seq < stop.firstSeq) {
      stop.firstSeq = seq;
      stop.firstArrival = row['arrival_time'];
      stop.firstDeparture = row['departure_time'];
    }
    if (seq > stop.lastSeq) {
      stop.lastSeq = seq;
      stop.lastArrival = row['arrival_time'];
      stop.lastDeparture = row['departure_time'];
    }
  }
  for (const [id, stop] of seen) {
    const trip = trips.get(id)!;
    const start = parseGtfsTime(stop.firstDeparture) ?? parseGtfsTime(stop.firstArrival);
    const end = parseGtfsTime(stop.lastArrival) ?? parseGtfsTime(stop.lastDeparture);
    trip.template = start === null || end === null ? null : { startSecs: start, endSecs: end };
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
 * (the memory limit), or `aborted`.
 */
export async function parseSchedule(
  body: ChunkedBody,
  budget: MemoryBudget,
  signal: AbortSignal,
): Promise<ScheduleStore> {
  const archive = await ZipArchive.open(body);
  try {
    checkRequiredFiles(archive);
    const agency = await readAgency(archive, budget, signal);
    const routes = await readRoutes(archive, budget, signal);
    const trips = await readTrips(archive, budget, signal);
    const calendar = await readCalendar(archive, budget, signal);
    await readFrequencies(archive, trips, budget, signal);
    await readTemplates(archive, trips, budget, signal);
    const shapes = archive.has('shapes.txt')
      ? await encodeShapes(
          () =>
            readCsv(
              archive,
              'shapes.txt',
              ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
              signal,
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
