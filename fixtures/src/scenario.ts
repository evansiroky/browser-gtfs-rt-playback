import { encodePolyline6 } from '@gtfs-rt-debugger/shared';
import {
  AGENCIES,
  MISSING_SHAPE_ID,
  ROUTES,
  STOPS,
  STOP_IDS,
  TIMEZONE,
  shapeRowsInFileOrder,
  sortedShapePoints,
} from './catalog.js';
import type { Row } from './csv.js';
import { evaluate, operatesOn, type Expected, type RefSource } from './expected.js';
import { ShapePath } from './geo.js';
import {
  encodeFeeds,
  type Feeds,
  type RealtimeSpec,
  type TripRef,
  type TripUpdateSpec,
  type VehicleSpec,
} from './rt.js';
import {
  WEEKDAY_COLUMNS,
  buildScheduleZip,
  type ScheduleData,
  type StopTimeData,
  type TripData,
} from './schedule.js';
import { addDays, formatHms, instantSeconds, serviceDateOf, weekdayOf } from './time.js';

export interface ScenarioOptions {
  /**
   * Include `freq-mixed`, the frequency trip whose rows disagree on `exact_times`, and the vehicle
   * that references it. Default true.
   */
  includeMisconfiguredTrip?: boolean;
}

/** What a loader must find in the zip; independent of `now` except for the calendar dates. */
export interface ExpectedSchedule {
  agency: { names: string[]; timezone: string };
  routes: Row[];
  /** Every `trips.txt` row, every column. */
  trips: Row[];
  /** Every `frequencies.txt` row, every column. */
  frequencies: Row[];
  /** First and last stop time per trip, seconds from the service day start (templates for frequency trips). */
  tripTimes: Record<string, { startSecs: number; endSecs: number }>;
  /** The precision-6 polyline each shape must encode to, points taken in `shape_pt_sequence` order. */
  shapes: Record<string, string>;
  /** Trips whose `shape_id` is absent from `shapes.txt`. */
  tripsWithoutShape: string[];
  /** Whether each service operates yesterday and today. */
  operates: Record<string, { yesterday: boolean; today: boolean }>;
}

export interface ScenarioExpected extends Expected {
  schedule: ExpectedSchedule;
}

export interface Scenario {
  /** The instant the scenario was built for. */
  now: Date;
  scheduleZip: Uint8Array;
  /** The vehicle positions feed at `now`. */
  vehiclePositions: Uint8Array;
  /** The trip updates feed at `now`. */
  tripUpdates: Uint8Array;
  expected: ScenarioExpected;
  /** The schedule as data, for tests that need more than the zip. */
  schedule: ScheduleData;
  /**
   * The feeds as published `seconds` after (or, if negative, before) `now`: vehicles further along
   * their shapes, newer timestamps, the same schedule and trip references. Pure: the result
   * depends only on `seconds`, not on earlier calls. `expected` describes `now` only.
   */
  advance(seconds: number): { now: Date; vehiclePositions: Uint8Array; tripUpdates: Uint8Array };
}

type StopStyle = 'plain' | 'dwell' | 'arrival-only';

function stopTimes(start: number, end: number, style: StopStyle): StopTimeData[] {
  const last = STOP_IDS.length - 1;
  return STOP_IDS.map((stopId, i) => {
    const t = start + Math.round((i * (end - start)) / last);
    if (i === 0 && style === 'dwell')
      return { stopId, arrival: Math.max(0, start - 120), departure: t };
    if (i === last && style === 'dwell') return { stopId, arrival: t, departure: t + 120 };
    if (i === 0 && style === 'arrival-only') return { stopId, arrival: t, departure: null };
    if (i === last && style === 'arrival-only') return { stopId, arrival: null, departure: t };
    return { stopId, arrival: t, departure: t };
  });
}

interface FrequencyWindow {
  start: number;
  end: number;
  headway: number;
  /** The `exact_times` cell as written; '' leaves it absent. */
  exact: string;
}

/** Nominal instance starts of a window, in seconds from the service day start. */
function instanceStarts(w: FrequencyWindow): number[] {
  const starts: number[] = [];
  for (let s = w.start; s < w.end; s += w.headway) starts.push(s);
  return starts;
}

export function scenario(now: Date = new Date(), options: ScenarioOptions = {}): Scenario {
  const includeMisconfigured = options.includeMisconfiguredTrip ?? true;
  const nowMs = now.getTime();
  const today = serviceDateOf(now, TIMEZONE);
  const yesterday = addDays(today, -1);
  const dayStart = instantSeconds(today, 0, TIMEZONE);
  const yesterdayStart = instantSeconds(yesterday, 0, TIMEZONE);
  /** Seconds from today's service day start to the start of the current minute. */
  const s = Math.floor(nowMs / 60_000) * 60 - dayStart;

  const shapeRows = shapeRowsInFileOrder();
  const shapePoints = sortedShapePoints(shapeRows);
  const paths = new Map([...shapePoints].map(([id, points]) => [id, new ShapePath(points)]));

  const trips: TripData[] = [];
  const vehicles: VehicleSpec[] = [];
  const updates: TripUpdateSpec[] = [];
  const hms = formatHms;

  function addTrip(
    id: string,
    o: {
      service: string;
      route: string;
      shape: string;
      headsign: string;
      direction: number;
      block?: string;
      times: StopTimeData[];
      frequencies?: FrequencyWindow[];
    },
  ): void {
    trips.push({
      row: {
        route_id: o.route,
        service_id: o.service,
        trip_id: id,
        trip_headsign: o.headsign,
        trip_short_name: id.slice(0, 4).toUpperCase(),
        direction_id: String(o.direction),
        block_id: o.block ?? '',
        shape_id: o.shape,
        wheelchair_accessible: '1',
        bikes_allowed: o.direction === 0 ? '1' : '2',
      },
      stopTimes: o.times,
      frequencies: (o.frequencies ?? []).map((w) => ({
        trip_id: id,
        start_time: hms(w.start),
        end_time: hms(w.end),
        headway_secs: String(w.headway),
        exact_times: w.exact,
      })),
    });
  }

  /** A plain trip spanning [s + from, s + to]; a start before the service day begins is clamped to it. Null when it would end before the day began. */
  function span(from: number, to: number): [number, number] | null {
    return s + to < 0 ? null : [Math.max(0, s + from), s + to];
  }

  /** First point of the grid `anchor + k * headway` that is not before the service day start. */
  function gridStart(offset: number, headway: number): number {
    const raw = s + offset;
    return raw >= 0 ? raw : raw + headway * Math.ceil(-raw / headway);
  }

  let vehicleCount = 0;
  function addVehicle(
    ref: TripRef | null,
    motion: { shape: string; start: number; end: number; startsOnYesterday?: boolean },
  ): string {
    const n = 100 + ++vehicleCount;
    const base = motion.startsOnYesterday ? yesterdayStart : dayStart;
    vehicles.push({
      entityId: `vp-${n}`,
      vehicleId: `bus-${n}`,
      label: `Bus ${n}`,
      licensePlate: n % 2 === 0 ? `FX-${n}` : null,
      ref,
      shapeId: motion.shape,
      motionStart: base + motion.start,
      durationSecs: Math.max(1, motion.end - motion.start),
      lagSecs: 2 + (n % 7),
      occupancy: (n % 4) as VehicleSpec['occupancy'],
      occupancyPercentage: (n * 7) % 100,
    });
    return `bus-${n}`;
  }

  let updateCount = 0;
  function addUpdate(ref: TripRef, vehicleId: string | null, stopSequences: number[]): void {
    const n = ++updateCount;
    updates.push({
      entityId: `tu-${n}`,
      ref,
      vehicleId,
      delaySecs: 60 * (n % 4) - 30,
      stopSequences,
      lagSecs: 1 + n,
    });
  }

  // ---- plain trips on DAILY, all relative to the current minute ----------------------------
  let t = span(-1800, 1800);
  if (t) {
    addTrip('plain-active-vp-tu', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-market',
      headsign: 'Downtown, via Market',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    const bus = addVehicle(
      { tripId: 'plain-active-vp-tu', startDate: today },
      { shape: 'shape-market', start: t[0], end: t[1] },
    );
    addUpdate({ tripId: 'plain-active-vp-tu', startDate: today }, bus, [3, 4, 5]);
  }

  t = span(-1200, 2400);
  if (t) {
    addTrip('plain-active-vp', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-vanness',
      headsign: 'North Beach',
      direction: 1,
      times: stopTimes(t[0], t[1], 'dwell'),
    });
    addVehicle({ tripId: 'plain-active-vp' }, { shape: 'shape-vanness', start: t[0], end: t[1] });
  }

  t = span(-600, 900);
  if (t) {
    addTrip('plain-active-tu', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-mission',
      headsign: 'Daly City',
      direction: 0,
      block: 'B1',
      times: stopTimes(t[0], t[1], 'arrival-only'),
    });
    addUpdate({ tripId: 'plain-active-tu', startDate: today }, null, [2, 3, 4, 5]);
  }

  t = span(-2400, 300);
  if (t) {
    addTrip('plain-active-no-rt', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-embarcadero',
      headsign: 'Bayview',
      direction: 1,
      block: 'B1',
      times: stopTimes(t[0], t[1], 'plain'),
    });
  }

  t = span(-300, 3000);
  if (t) {
    addTrip('plain-active-missing-shape', {
      service: 'DAILY',
      route: 'R3',
      shape: MISSING_SHAPE_ID,
      headsign: 'Airport',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
  }

  t = span(3600, 7200);
  if (t) {
    addTrip('plain-future', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-market',
      headsign: 'Downtown, via Market',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    addVehicle({ tripId: 'plain-future' }, { shape: 'shape-market', start: t[0], end: t[1] });
  }

  t = span(-6000, -2400);
  if (t) {
    addTrip('plain-past', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-vanness',
      headsign: 'North Beach',
      direction: 1,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    const bus = addVehicle(
      { tripId: 'plain-past', startDate: today },
      { shape: 'shape-vanness', start: t[0], end: t[1] },
    );
    addUpdate({ tripId: 'plain-past', startDate: today }, bus, []);
  }

  // Boundaries of "overlaps the current minute": start before m + 60 and end at or after m.
  for (const [id, from, to] of [
    ['edge-ends-this-minute', -1800, 0],
    ['edge-ended-last-second', -1800, -1],
    ['edge-starts-this-minute', 59, 1800],
    ['edge-starts-next-minute', 60, 1800],
  ] as const) {
    t = span(from, to);
    if (t) {
      addTrip(id, {
        service: 'DAILY',
        route: 'R2',
        shape: 'shape-vanness',
        headsign: 'Boundary',
        direction: 0,
        times: stopTimes(t[0], t[1], 'plain'),
      });
    }
  }

  // ---- service calendar variants ----------------------------------------------------------
  t = span(-900, 1500);
  if (t) {
    addTrip('plain-active-added-service', {
      service: 'ADDED_TODAY',
      route: 'R3',
      shape: 'shape-market',
      headsign: 'Special Event',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    addVehicle(
      { tripId: 'plain-active-added-service', startDate: today },
      { shape: 'shape-market', start: t[0], end: t[1] },
    );
  }

  t = span(-900, 900);
  if (t) {
    addTrip('plain-nis-removed-today', {
      service: 'REMOVED_TODAY',
      route: 'R2',
      shape: 'shape-mission',
      headsign: 'Daly City',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    addVehicle(
      { tripId: 'plain-nis-removed-today', startDate: today },
      { shape: 'shape-mission', start: t[0], end: t[1] },
    );
    addTrip('plain-nis-off-weekday', {
      service: 'OFFDAY',
      route: 'R2',
      shape: 'shape-embarcadero',
      headsign: 'Bayview',
      direction: 1,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    addVehicle(
      { tripId: 'plain-nis-off-weekday' },
      { shape: 'shape-embarcadero', start: t[0], end: t[1] },
    );
  }

  // Runs 23:30 to 01:30 the next morning, on a service whose last day is yesterday.
  addTrip('overnight-from-yesterday', {
    service: 'NIGHT',
    route: 'R3',
    shape: 'shape-vanness',
    headsign: 'Owl',
    direction: 0,
    times: stopTimes(23.5 * 3600, 25.5 * 3600, 'plain'),
  });
  addVehicle(
    { tripId: 'overnight-from-yesterday' },
    { shape: 'shape-vanness', start: 23.5 * 3600, end: 25.5 * 3600, startsOnYesterday: true },
  );

  // ---- frequency trips ---------------------------------------------------------------------
  const activeInstances = (starts: number[], duration: number): number[] =>
    starts.filter((start) => start < s + 60 && start + duration >= s);

  // exact_times = 1, one window, headway 10 min, template 06:00:00 to 06:20:00 (20 min).
  {
    const window: FrequencyWindow = {
      start: gridStart(-2100, 600),
      end: s + 4500,
      headway: 600,
      exact: '1',
    };
    const duration = 1200;
    addTrip('freq-exact', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-market',
      headsign: 'Downtown, via Market',
      direction: 0,
      times: stopTimes(6 * 3600, 6 * 3600 + duration, 'plain'),
      frequencies: [window],
    });
    const starts = instanceStarts(window);
    const [first, second] = activeInstances(starts, duration);
    const future = starts.find((start) => start >= s + 60);
    const motion = (start: number) => ({ shape: 'shape-market', start, end: start + duration });
    if (first !== undefined) {
      addVehicle({ tripId: 'freq-exact', startTime: hms(first) }, motion(first));
      // a feed that reports the actual start (90 s late) instead of the nominal one
      addVehicle(
        { tripId: 'freq-exact', startDate: today, startTime: hms(first + 90) },
        motion(first + 90),
      );
    }
    if (second !== undefined) {
      addUpdate({ tripId: 'freq-exact', startDate: today, startTime: hms(second) }, null, [3, 4]);
    }
    if (future !== undefined) {
      addVehicle({ tripId: 'freq-exact', startTime: hms(future) }, motion(future));
    }
  }

  // exact_times = 0 and absent (both read as 0, so not mixed), two windows, headways 15 and 10 min.
  {
    const windows: FrequencyWindow[] = [
      { start: gridStart(-3000, 900), end: s + 600, headway: 900, exact: '0' },
      { start: s + 1200, end: s + 3000, headway: 600, exact: '' },
    ];
    const duration = 1800;
    addTrip('freq-nominal', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-mission',
      headsign: 'Daly City',
      direction: 0,
      times: stopTimes(12 * 3600, 12 * 3600 + duration, 'plain'),
      frequencies: windows,
    });
    const [first] = activeInstances(windows.flatMap(instanceStarts), duration);
    if (first !== undefined) {
      addVehicle(
        { tripId: 'freq-nominal', startDate: today, startTime: hms(first) },
        { shape: 'shape-mission', start: first, end: first + duration },
      );
    }
    // a reference with no start_time cannot be tied to an instance
    const bus = addVehicle(
      { tripId: 'freq-nominal' },
      { shape: 'shape-mission', start: s - 300, end: s + 1500 },
    );
    addUpdate({ tripId: 'freq-nominal' }, bus, [2]);
  }

  // exact_times 1 and absent (0): mixed, a configuration error.
  if (includeMisconfigured) {
    addTrip('freq-mixed', {
      service: 'DAILY',
      route: 'R3',
      shape: 'shape-embarcadero',
      headsign: 'Airport',
      direction: 0,
      times: stopTimes(9 * 3600, 9 * 3600 + 900, 'plain'),
      frequencies: [
        { start: gridStart(-1800, 300), end: s + 1800, headway: 300, exact: '1' },
        { start: s + 1800, end: s + 3600, headway: 300, exact: '' },
      ],
    });
    addVehicle(
      { tripId: 'freq-mixed', startTime: hms(s) },
      { shape: 'shape-embarcadero', start: s - 300, end: s + 600 },
    );
  }

  // ---- realtime that the schedule cannot explain -------------------------------------------
  addVehicle(
    { tripId: 'ghost-vp-trip', startDate: today, startTime: hms(Math.max(0, s - 300)) },
    { shape: 'shape-market', start: s - 300, end: s + 900 },
  );
  addUpdate({ tripId: 'ghost-tu-trip', startDate: today }, null, []);
  addVehicle(null, { shape: 'shape-embarcadero', start: s - 600, end: s + 1200 });
  addVehicle(
    { tripId: '', routeId: 'R2' },
    { shape: 'shape-mission', start: s - 900, end: s + 900 },
  );

  // ---- calendar ----------------------------------------------------------------------------
  const flags = (days: (d: number) => boolean): Row =>
    Object.fromEntries(WEEKDAY_COLUMNS.map((c, i) => [c, days((i + 1) % 7) ? '1' : '0']));
  const calendar = (id: string, end: string, days: (d: number) => boolean = () => true): Row => ({
    service_id: id,
    ...flags(days),
    start_date: addDays(today, -30),
    end_date: end,
  });
  const farEnd = addDays(today, 30);
  const schedule: ScheduleData = {
    agencies: AGENCIES,
    routes: ROUTES,
    stops: STOPS,
    calendar: [
      calendar('DAILY', farEnd),
      calendar('REMOVED_TODAY', farEnd),
      calendar('OFFDAY', farEnd, (d) => d !== weekdayOf(today) && d !== weekdayOf(yesterday)),
      calendar('NIGHT', yesterday),
    ],
    calendarDates: [
      { service_id: 'REMOVED_TODAY', date: today, exception_type: '2' },
      { service_id: 'ADDED_TODAY', date: today, exception_type: '1' },
    ],
    trips,
    shapeRows,
  };

  // ---- ground truth ------------------------------------------------------------------------
  const source = (list: { ref: TripRef | null; vehicleId: string | null }[]): RefSource[] => list;
  const expected = evaluate({
    data: schedule,
    timeZone: TIMEZONE,
    nowMs,
    vehicles: source(vehicles.map((v) => ({ ref: v.ref, vehicleId: v.vehicleId }))),
    tripUpdates: source(updates.map((u) => ({ ref: u.ref, vehicleId: u.vehicleId }))),
  });

  const serviceIds = [...new Set(trips.map((tr) => tr.row.service_id!))].sort();
  const expectedSchedule: ExpectedSchedule = {
    agency: { names: AGENCIES.map((a) => a.agency_name!), timezone: TIMEZONE },
    routes: ROUTES,
    trips: trips.map((tr) => tr.row),
    frequencies: trips.flatMap((tr) => tr.frequencies),
    tripTimes: Object.fromEntries(
      trips.map((tr) => {
        const first = tr.stopTimes[0]!;
        const last = tr.stopTimes[tr.stopTimes.length - 1]!;
        return [
          tr.row.trip_id!,
          {
            startSecs: (first.departure ?? first.arrival)!,
            endSecs: (last.arrival ?? last.departure)!,
          },
        ];
      }),
    ),
    shapes: Object.fromEntries(
      [...shapePoints].map(([id, points]) => [id, encodePolyline6(points)]),
    ),
    tripsWithoutShape: trips
      .filter((tr) => !shapePoints.has(tr.row.shape_id!))
      .map((tr) => tr.row.trip_id!),
    operates: Object.fromEntries(
      serviceIds.map((id) => [
        id,
        { yesterday: operatesOn(schedule, id, yesterday), today: operatesOn(schedule, id, today) },
      ]),
    ),
  };

  const realtime: RealtimeSpec = { vehicles, tripUpdates: updates, paths };
  const feedsAt = (seconds: number): Feeds =>
    encodeFeeds(realtime, Math.floor(nowMs / 1000) + seconds);
  const initial = feedsAt(0);

  return {
    now,
    scheduleZip: buildScheduleZip(schedule),
    vehiclePositions: initial.vehiclePositions,
    tripUpdates: initial.tripUpdates,
    expected: { ...expected, schedule: expectedSchedule },
    schedule,
    advance(seconds) {
      return { now: new Date(nowMs + seconds * 1000), ...feedsAt(seconds) };
    },
  };
}
