import type { ListName, TripListItem } from '@gtfs-rt-debugger/shared';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { FakeClock } from '../clock.js';
import { decodeFeed, SnapshotStore, type FeedKind } from '../realtime/snapshot-store.js';
import { LoadGuard } from '../schedule/guard.js';
import { MemoryBudget } from '../schedule/memory.js';
import { parseSchedule } from '../schedule/parse.js';
import type { ScheduleStore } from '../schedule/store.js';
import { TripEngine } from '../trips/engine.js';
import { PingStore } from '../trips/pings.js';
import { captureLogger } from './logger.js';
import { chunked, zipOf } from './zip.js';

const { transit_realtime } = GtfsRealtimeBindings;
type IFeedEntity = GtfsRealtimeBindings.transit_realtime.IFeedEntity;

export interface TripSpec {
  id: string;
  service?: string;
  route?: string;
  /** First and last stop time of a two-stop trip; `null` leaves the cell empty. */
  start?: string | null;
  end?: string | null;
  /** Every stop as [arrival, departure], overriding `start` and `end`; `[]` writes no rows. */
  stops?: [string, string][];
  /** Frequency rows: window start, window end, headway, `exact_times` as written. */
  freq?: [string, string, string | number, string?][];
  headsign?: string;
  shape?: string;
}

export interface ScheduleSpec {
  timezone?: string;
  trips: TripSpec[];
  /** `service_id` to the seven weekday flags (Monday first); default every day 2020-2030. */
  calendar?: Record<string, { days?: string; start?: string; end?: string }>;
  /** `[service_id, date, exception_type]`. */
  calendarDates?: [string, string, string][];
}

/** Parses a schedule written compactly, through the real loader code. */
export async function loadSchedule(spec: ScheduleSpec): Promise<ScheduleStore> {
  const calendar: NonNullable<ScheduleSpec['calendar']> = { DAILY: {}, ...spec.calendar };
  const rows = (lines: string[][]) => lines.map((l) => l.join(',')).join('\n') + '\n';
  const files = {
    'agency.txt': rows([
      ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
      ['A', 'Test Transit', 'https://x.test', spec.timezone ?? 'America/Los_Angeles'],
    ]),
    'routes.txt': rows([
      ['route_id', 'route_short_name', 'route_long_name', 'route_type'],
      ['R1', '1', 'One', '3'],
      ['R2', '2', 'Two', '3'],
    ]),
    'trips.txt': rows([
      ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'shape_id'],
      ...spec.trips.map((t) => [
        t.route ?? 'R1',
        t.service ?? 'DAILY',
        t.id,
        t.headsign ?? '',
        t.shape ?? '',
      ]),
    ]),
    'stop_times.txt': rows([
      ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
      ...spec.trips.flatMap((t) =>
        (
          t.stops ?? [
            [t.start ?? '', t.start ?? ''],
            [t.end ?? '', t.end ?? ''],
          ]
        ).map(([arrival, departure], i) => [t.id, arrival, departure, `S${i}`, String(i + 1)]),
      ),
    ]),
    'calendar.txt': rows([
      [
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
      ],
      ...Object.entries(calendar).map(([id, c]) => [
        id,
        ...(c.days ?? '1111111').split(''),
        c.start ?? '20200101',
        c.end ?? '20301231',
      ]),
    ]),
    'calendar_dates.txt': rows([
      ['service_id', 'date', 'exception_type'],
      ...(spec.calendarDates ?? []),
    ]),
    'frequencies.txt': rows([
      ['trip_id', 'start_time', 'end_time', 'headway_secs', 'exact_times'],
      ...spec.trips.flatMap((t) =>
        (t.freq ?? []).map(([start, end, headway, exact]) => [
          t.id,
          start,
          end,
          String(headway),
          exact ?? '',
        ]),
      ),
    ]),
  };
  return parseSchedule(
    chunked(zipOf(files)),
    new MemoryBudget(1 << 30),
    LoadGuard.unlimited(new AbortController().signal),
  );
}

/** A vehicle position entity; every argument beyond the entity ID is the feed's own. */
export function vehicle(
  id: string,
  position: GtfsRealtimeBindings.transit_realtime.IVehiclePosition,
): IFeedEntity {
  return { id, vehicle: position };
}

/** A trip update entity. */
export function update(
  id: string,
  tripUpdate: GtfsRealtimeBindings.transit_realtime.ITripUpdate,
): IFeedEntity {
  return { id, tripUpdate };
}

export function encode(entities: IFeedEntity[], timestamp: number | null): Uint8Array {
  return transit_realtime.FeedMessage.encode(
    transit_realtime.FeedMessage.create({
      header: { gtfsRealtimeVersion: '2.0', ...(timestamp === null ? {} : { timestamp }) },
      entity: entities,
    }),
  ).finish();
}

/** Everything the engine reads, on a fake clock. */
export function harness(options: {
  now: Date | string;
  store?: ScheduleStore | null;
  retentionMs?: number;
  memoryLimitBytes?: number;
}) {
  const clock = new FakeClock(new Date(options.now).getTime());
  const logs: string[] = [];
  const snapshots = new SnapshotStore({
    clock,
    logger: captureLogger(logs),
    retentionMs: options.retentionMs ?? 3_600_000,
    memoryLimitBytes: options.memoryLimitBytes ?? 1 << 30,
  });
  const pings = new PingStore(snapshots);
  let schedule = options.store ?? null;
  const engine = new TripEngine({ clock, snapshots, pings, schedule: () => schedule });
  return {
    clock,
    snapshots,
    pings,
    engine,
    logs,
    setSchedule(store: ScheduleStore | null) {
      schedule = store;
    },
    /** Adds a snapshot of `feed` received now; the header timestamp defaults to now. */
    push(feed: FeedKind, entities: IFeedEntity[], timestamp: number | null = clock.now() / 1000) {
      const bytes = encode(entities, timestamp === null ? null : Math.floor(timestamp));
      return snapshots.add(feed, bytes, decodeFeed(bytes));
    },
    ids(list: ListName): string[] {
      return engine.list(list).trips.map(describe);
    },
  };
}

/** `tripId@start` (epoch seconds), or `tripId` for a row without a span, plus the reason. */
export function describe(item: TripListItem): string {
  return `${item.tripId}${item.scheduledStart === null ? '' : `@${item.scheduledStart}`}${
    item.reason ? `:${item.reason}` : ''
  }`;
}

/** Epoch seconds of an ISO instant. */
export const seconds = (iso: string): number => Date.parse(iso) / 1000;
