import { strToU8, zipSync, type Zippable } from 'fflate';
import type { ShapeRow } from './catalog.js';
import { toCsv, type Row } from './csv.js';
import { formatHms } from './time.js';

export interface StopTimeData {
  stopId: string;
  /** Seconds from the service day start; null writes an empty cell. */
  arrival: number | null;
  departure: number | null;
}

export interface TripData {
  /** The `trips.txt` row, every column. */
  row: Row;
  stopTimes: StopTimeData[];
  /** `frequencies.txt` rows of this trip, every column (`trip_id` included). */
  frequencies: Row[];
}

export interface ScheduleData {
  agencies: Row[];
  routes: Row[];
  stops: Row[];
  calendar: Row[];
  calendarDates: Row[];
  trips: TripData[];
  shapeRows: ShapeRow[];
}

export const CALENDAR_COLUMNS = [
  'service_id',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'start_date',
  'end_date',
];
export const WEEKDAY_COLUMNS = CALENDAR_COLUMNS.slice(1, 8);

const hms = (seconds: number | null): string => (seconds === null ? '' : formatHms(seconds));

/** The GTFS Schedule zip for `data`. Byte-for-byte deterministic. */
export function buildScheduleZip(data: ScheduleData): Uint8Array {
  const stopTimeRows = data.trips.flatMap((trip) =>
    trip.stopTimes.map((st, i): Row => ({
      trip_id: trip.row.trip_id!,
      arrival_time: hms(st.arrival),
      departure_time: hms(st.departure),
      stop_id: st.stopId,
      stop_sequence: String(i + 1),
    })),
  );
  const files: Record<string, string> = {
    'agency.txt': toCsv(
      ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
      data.agencies,
    ),
    'routes.txt': toCsv(
      [
        'route_id',
        'agency_id',
        'route_short_name',
        'route_long_name',
        'route_desc',
        'route_type',
        'route_url',
        'route_color',
        'route_text_color',
      ],
      data.routes,
    ),
    'trips.txt': toCsv(
      [
        'route_id',
        'service_id',
        'trip_id',
        'trip_headsign',
        'trip_short_name',
        'direction_id',
        'block_id',
        'shape_id',
        'wheelchair_accessible',
        'bikes_allowed',
      ],
      data.trips.map((t) => t.row),
    ),
    'stops.txt': toCsv(['stop_id', 'stop_name', 'stop_lat', 'stop_lon'], data.stops),
    'stop_times.txt': toCsv(
      ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
      stopTimeRows,
    ),
    'calendar.txt': toCsv(CALENDAR_COLUMNS, data.calendar),
    'calendar_dates.txt': toCsv(['service_id', 'date', 'exception_type'], data.calendarDates),
    'frequencies.txt': toCsv(
      ['trip_id', 'start_time', 'end_time', 'headway_secs', 'exact_times'],
      data.trips.flatMap((t) => t.frequencies),
    ),
    'shapes.txt': toCsv(
      ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'],
      data.shapeRows.map((r) => ({
        shape_id: r.shapeId,
        shape_pt_lat: r.latitude.toFixed(6),
        shape_pt_lon: r.longitude.toFixed(6),
        shape_pt_sequence: String(r.sequence),
        shape_dist_traveled: r.distTraveled.toFixed(1),
      })),
    ),
  };
  // A fixed modification time (built from local fields, which fflate reads back as local) keeps
  // the archive identical across runs and host timezones.
  const mtime = new Date(2020, 0, 1, 12, 0, 0);
  const entries: Zippable = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, [strToU8(text), { mtime }]]),
  );
  return zipSync(entries, { level: 6 });
}
