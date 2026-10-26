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
  vehicleTimestamp,
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
   * Include the trips with a configuration error and the vehicles that reference them:
   * `freq-mixed` and `freq-mixed-removed-today` (rows that disagree on `exact_times`) and the
   * four `cfg-` trips without usable stop times. Default true.
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
  /**
   * First and last stop time per trip, seconds from the service day start (templates for
   * frequency trips). Trips without usable stop times are not in it; see `tripsWithoutTemplate`.
   */
  tripTimes: Record<string, { startSecs: number; endSecs: number }>;
  /** Trips with no stop times, or no time at their first or last stop, in `trips.txt` order. */
  tripsWithoutTemplate: string[];
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

/** First departure (else arrival) and last arrival (else departure); null when either is missing. */
function templateOf(trip: TripData): { startSecs: number; endSecs: number } | null {
  const first = trip.stopTimes[0];
  const last = trip.stopTimes[trip.stopTimes.length - 1];
  const startSecs = first && (first.departure ?? first.arrival);
  const endSecs = last && (last.arrival ?? last.departure);
  return startSecs === undefined || startSecs === null || endSecs === undefined || endSecs === null
    ? null
    : { startSecs, endSecs };
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

// The shapes do not depend on the instant.
const shapeRows = shapeRowsInFileOrder();
const shapePoints = sortedShapePoints(shapeRows);
const paths = new Map([...shapePoints].map(([id, points]) => [id, new ShapePath(points)]));
const shapePolylines = Object.fromEntries(
  [...shapePoints].map(([id, points]) => [id, encodePolyline6(points)]),
);

export function scenario(now: Date = new Date(), options: ScenarioOptions = {}): Scenario {
  const includeMisconfigured = options.includeMisconfiguredTrip ?? true;
  const nowMs = now.getTime();
  const nowSec = Math.floor(nowMs / 1000);
  const today = serviceDateOf(now, TIMEZONE);
  const yesterday = addDays(today, -1);
  const tomorrow = addDays(today, 1);
  const dayStart = instantSeconds(today, 0, TIMEZONE);
  const yesterdayStart = instantSeconds(yesterday, 0, TIMEZONE);
  /**
   * Seconds from today's service day start to the start of the current minute. Negative for the
   * hour of the fall-back day before its service day starts (noon minus 12 h is 01:00 then).
   */
  const s = Math.floor(nowMs / 60_000) * 60 - dayStart;

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

  /**
   * A plain trip spanning [s + from, s + to]. A start before the service day begins is clamped to
   * it; null when the trip would end before the day began.
   */
  function span(from: number, to: number): [number, number] | null {
    return s + to < 0 ? null : [Math.max(0, s + from), s + to];
  }

  /** First point of the grid `s + offset + k * headway` that is not before the service day start. */
  function gridStart(offset: number, headway: number): number {
    const raw = s + offset;
    return raw >= 0 ? raw : raw + headway * Math.ceil(-raw / headway);
  }

  /** A frequency window, or null when it is empty (it ends at or before it starts). */
  function frequencyWindow(
    start: number,
    end: number,
    headway: number,
    exact: string,
  ): FrequencyWindow | null {
    return end > start ? { start, end, headway, exact } : null;
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
    const motion = { shape: 'shape-market', start: t[0], end: t[1] };
    addVehicle({ tripId: 'plain-active-vp-tu', startDate: today }, motion);
    // a second vehicle on the same trip ID, and a trip update naming a third, unseen vehicle
    addVehicle(
      { tripId: 'plain-active-vp-tu', startDate: today },
      { ...motion, start: t[0] + 300 },
    );
    addUpdate({ tripId: 'plain-active-vp-tu', startDate: today }, 'tu-unit-1', [3, 4, 5]);
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

  // Deliberately not conformant GTFS: no departure at the first stop, no arrival at the last. It
  // pins the data-model fallbacks (start = departure else arrival, end = arrival else departure).
  t = span(-600, 900);
  if (t) {
    addTrip('plain-active-tu', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-mission',
      headsign: 'Daly City',
      direction: 0,
      times: stopTimes(t[0], t[1], 'arrival-only'),
    });
    addUpdate({ tripId: 'plain-active-tu', startDate: today }, 'tu-unit-2', [2, 3, 4, 5]);
  }

  t = span(-2400, 300);
  if (t) {
    addTrip('plain-active-no-rt', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-embarcadero',
      headsign: 'Bayview',
      direction: 1,
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

  // B1 is one vehicle's block: the past trip, then the future one.
  t = span(3600, 7200);
  if (t) {
    addTrip('plain-future', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-market',
      headsign: 'Downtown, via Market',
      direction: 0,
      block: 'B1',
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
      block: 'B1',
      times: stopTimes(t[0], t[1], 'plain'),
    });
    const bus = addVehicle(
      { tripId: 'plain-past', startDate: today },
      { shape: 'shape-vanness', start: t[0], end: t[1] },
    );
    addUpdate({ tripId: 'plain-past', startDate: today }, bus, [4, 5]);
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

  // ---- references that name a service date --------------------------------------------------
  // Both trips are active today, so each is also in list 2: the reference's date is not today's.
  t = span(-600, 1200);
  if (t) {
    addTrip('plain-ref-yesterday', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-mission',
      headsign: 'Daly City',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    addVehicle(
      { tripId: 'plain-ref-yesterday', startDate: yesterday },
      { shape: 'shape-mission', start: t[0], end: t[1] },
    );
  }
  t = span(-300, 1500);
  if (t) {
    addTrip('plain-ref-tomorrow', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-market',
      headsign: 'Downtown, via Market',
      direction: 0,
      times: stopTimes(t[0], t[1], 'plain'),
    });
    addVehicle(
      { tripId: 'plain-ref-tomorrow', startDate: tomorrow },
      { shape: 'shape-market', start: t[0], end: t[1] },
    );
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

  // ---- trips that run past midnight --------------------------------------------------------
  // 23:30 to 01:30 the next morning, on a service whose last day is yesterday.
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

  // The same hours on a service that also runs today: just after midnight yesterday's run is
  // active while today's run is still ahead.
  addTrip('overnight-daily', {
    service: 'DAILY',
    route: 'R3',
    shape: 'shape-mission',
    headsign: 'Owl',
    direction: 1,
    times: stopTimes(23.5 * 3600, 25.5 * 3600, 'plain'),
  });
  addVehicle(
    { tripId: 'overnight-daily' },
    { shape: 'shape-mission', start: 23.5 * 3600, end: 25.5 * 3600, startsOnYesterday: true },
  );

  // ---- frequency trips ---------------------------------------------------------------------
  const activeInstances = (starts: number[], duration: number): number[] =>
    starts.filter((start) => start < s + 60 && start + duration >= s);

  // exact_times = 1, one window, headway 10 min, template 06:00:00 to 06:20:00 (20 min). The
  // window end falls on the headway grid, where no instance is generated.
  {
    const duration = 1200;
    const w = frequencyWindow(gridStart(-2100, 600), s + 4500, 600, '1');
    if (w) {
      addTrip('freq-exact', {
        service: 'DAILY',
        route: 'R1',
        shape: 'shape-market',
        headsign: 'Downtown, via Market',
        direction: 0,
        times: stopTimes(6 * 3600, 6 * 3600 + duration, 'plain'),
        frequencies: [w],
      });
      const starts = instanceStarts(w);
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
      // a start equal to the window end: no instance there, and the window excludes its end
      addVehicle({ tripId: 'freq-exact', startTime: hms(w.end) }, motion(w.end));
    }
  }

  // exact_times 0 and absent (both read as 0, so not mixed): two adjacent windows with headways
  // of 15 and 10 minutes, each holding an active instance.
  {
    const duration = 1800;
    const rowA = frequencyWindow(gridStart(-3000, 900), s - 600, 900, '0');
    const rowB = frequencyWindow(gridStart(-600, 600), s + 2400, 600, '');
    const rows = [rowA, rowB].filter((w): w is FrequencyWindow => w !== null);
    if (rows.length > 0) {
      addTrip('freq-nominal', {
        service: 'DAILY',
        route: 'R2',
        shape: 'shape-mission',
        headsign: 'Daly City',
        direction: 0,
        times: stopTimes(12 * 3600, 12 * 3600 + duration, 'plain'),
        frequencies: rows,
      });
      const motion = (start: number) => ({ shape: 'shape-mission', start, end: start + duration });
      const activeA = rowA ? activeInstances(instanceStarts(rowA), duration) : [];
      const activeB = rowB ? activeInstances(instanceStarts(rowB), duration) : [];
      if (activeA[0] !== undefined) {
        const start = activeA[0];
        addVehicle(
          { tripId: 'freq-nominal', startDate: today, startTime: hms(start) },
          motion(start),
        );
        // 90 s past a nominal start on an exact_times=0 row
        addVehicle(
          { tripId: 'freq-nominal', startDate: today, startTime: hms(start + 90) },
          motion(start + 90),
        );
      }
      if (activeB[0] !== undefined) {
        // 90 s past a nominal start on a row whose exact_times is absent
        const start = activeB[0];
        addVehicle(
          { tripId: 'freq-nominal', startDate: today, startTime: hms(start + 90) },
          motion(start + 90),
        );
      }
      const lastB = activeB[activeB.length - 1];
      if (lastB !== undefined) {
        addVehicle(
          { tripId: 'freq-nominal', startDate: today, startTime: hms(lastB) },
          motion(lastB),
        );
      }
      // a reference with no start_time cannot be tied to an instance
      const bus = addVehicle(
        { tripId: 'freq-nominal' },
        { shape: 'shape-mission', start: s - 300, end: s + 1500 },
      );
      addUpdate({ tripId: 'freq-nominal' }, bus, [2]);
    }
  }

  // A window that crosses midnight, 23:00:00 to 25:00:00: just after midnight, yesterday's
  // instances are active. The reference names one by its start_time (past 24:00:00) alone.
  {
    const duration = 1200;
    addTrip('freq-overnight', {
      service: 'DAILY',
      route: 'R3',
      shape: 'shape-embarcadero',
      headsign: 'Owl',
      direction: 0,
      times: stopTimes(8 * 3600, 8 * 3600 + duration, 'plain'),
      frequencies: [{ start: 23 * 3600, end: 25 * 3600, headway: 600, exact: '0' }],
    });
    addVehicle(
      { tripId: 'freq-overnight', startTime: '24:10:00' },
      {
        shape: 'shape-embarcadero',
        start: 24 * 3600 + 600,
        end: 24 * 3600 + 600 + duration,
        startsOnYesterday: true,
      },
    );
  }

  // A start_time that names an instance neither yesterday nor today has active: step 1 fails for
  // both dates, even though yesterday does have active instances just after midnight.
  addVehicle(
    { tripId: 'freq-overnight', startTime: '23:10:00' },
    { shape: 'shape-embarcadero', start: 23 * 3600 + 600, end: 23 * 3600 + 1800 },
  );

  // A frequency trip on a service that does not run today: whatever the reference says about its
  // start_time, the trip is not in service.
  addTrip('freq-nis', {
    service: 'OFFDAY',
    route: 'R2',
    shape: 'shape-mission',
    headsign: 'Daly City',
    direction: 0,
    times: stopTimes(10 * 3600, 10 * 3600 + 900, 'plain'),
    frequencies: [{ start: 6 * 3600, end: 8 * 3600, headway: 900, exact: '0' }],
  });
  addVehicle({ tripId: 'freq-nis' }, { shape: 'shape-mission', start: s - 300, end: s + 600 });
  addVehicle(
    { tripId: 'freq-nis', startTime: '03:33:33' },
    { shape: 'shape-mission', start: s - 200, end: s + 700 },
  );

  // exact_times 1 and absent (0): mixed, a configuration error. The second trip is also on a
  // service removed today, and the configuration error still takes precedence.
  if (includeMisconfigured) {
    const anchor = Math.max(s, 1800);
    addTrip('freq-mixed', {
      service: 'DAILY',
      route: 'R3',
      shape: 'shape-embarcadero',
      headsign: 'Airport',
      direction: 0,
      times: stopTimes(9 * 3600, 9 * 3600 + 900, 'plain'),
      frequencies: [
        { start: anchor - 1800, end: anchor + 1800, headway: 300, exact: '1' },
        { start: anchor + 1800, end: anchor + 3600, headway: 300, exact: '' },
      ],
    });
    addVehicle(
      { tripId: 'freq-mixed', startTime: hms(anchor) },
      { shape: 'shape-embarcadero', start: s - 300, end: s + 600 },
    );
    addTrip('freq-mixed-removed-today', {
      service: 'REMOVED_TODAY',
      route: 'R3',
      shape: 'shape-market',
      headsign: 'Airport',
      direction: 0,
      times: stopTimes(9 * 3600, 9 * 3600 + 900, 'plain'),
      frequencies: [
        { start: 6 * 3600, end: 7 * 3600, headway: 600, exact: '1' },
        { start: 7 * 3600, end: 8 * 3600, headway: 600, exact: '' },
      ],
    });
    addVehicle(
      { tripId: 'freq-mixed-removed-today', startDate: today },
      { shape: 'shape-market', start: s - 100, end: s + 800 },
    );
  }

  // Stop times from which no span can be computed (`unusable_stop_times`): no rows at all, no
  // time at the last stop, no time at the first stop of a frequency trip's template, and both
  // errors at once. Each would be active now if the missing times were read as zero or ignored.
  if (includeMisconfigured) {
    const untimed = { arrival: null, departure: null };
    const motion = { shape: 'shape-mission', start: s - 300, end: s + 900 };
    addTrip('cfg-no-stop-times', {
      service: 'DAILY',
      route: 'R2',
      shape: 'shape-mission',
      headsign: 'Nowhere',
      direction: 0,
      times: [],
    });
    addVehicle({ tripId: 'cfg-no-stop-times', startDate: today }, motion);

    const untimedEnd = stopTimes(0, 24 * 3600, 'plain');
    untimedEnd[untimedEnd.length - 1] = { ...untimedEnd[untimedEnd.length - 1]!, ...untimed };
    addTrip('cfg-last-stop-untimed', {
      service: 'DAILY',
      route: 'R1',
      shape: 'shape-market',
      headsign: 'Downtown, via Market',
      direction: 0,
      times: untimedEnd,
    });
    addVehicle({ tripId: 'cfg-last-stop-untimed' }, { ...motion, shape: 'shape-market' });
    addUpdate({ tripId: 'cfg-last-stop-untimed' }, null, [4]);

    const untimedStart = stopTimes(0, 1200, 'plain');
    untimedStart[0] = { ...untimedStart[0]!, ...untimed };
    addTrip('cfg-freq-first-stop-untimed', {
      service: 'DAILY',
      route: 'R3',
      shape: 'shape-embarcadero',
      headsign: 'Airport',
      direction: 0,
      times: untimedStart,
      frequencies: [{ start: 0, end: 26 * 3600, headway: 600, exact: '0' }],
    });
    addVehicle(
      { tripId: 'cfg-freq-first-stop-untimed', startTime: hms(Math.max(0, s - (s % 600))) },
      { ...motion, shape: 'shape-embarcadero' },
    );

    addTrip('cfg-mixed-and-no-stop-times', {
      service: 'DAILY',
      route: 'R3',
      shape: 'shape-embarcadero',
      headsign: 'Airport',
      direction: 0,
      times: [],
      frequencies: [
        { start: 0, end: 12 * 3600, headway: 600, exact: '1' },
        { start: 12 * 3600, end: 26 * 3600, headway: 600, exact: '' },
      ],
    });
    addVehicle(
      { tripId: 'cfg-mixed-and-no-stop-times', startDate: today },
      { ...motion, shape: 'shape-embarcadero' },
    );
  }

  // ---- realtime that the schedule cannot explain -------------------------------------------
  addVehicle(
    {
      tripId: 'ghost-vp-trip',
      startDate: today,
      startTime: hms(Math.max(0, s - 300)),
      routeId: 'R-GHOST',
    },
    { shape: 'shape-market', start: s - 300, end: s + 900 },
  );
  addUpdate({ tripId: 'ghost-tu-trip', startDate: today }, null, [2]);
  // Unknown trips whose route_id is in routes.txt: the names come from that route row.
  addVehicle(
    { tripId: 'ghost-known-route-vp-trip', startDate: today, routeId: 'R2' },
    { shape: 'shape-mission', start: s - 300, end: s + 900 },
  );
  addUpdate({ tripId: 'ghost-known-route-tu-trip', startDate: today, routeId: 'R3' }, null, [2]);
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
  const expected = evaluate({
    data: schedule,
    timeZone: TIMEZONE,
    nowMs,
    feedTimestamp: nowSec,
    vehicles: vehicles.map((v): RefSource => ({
      ref: v.ref,
      vehicleId: v.vehicleId,
      timestamp: vehicleTimestamp(v, nowSec),
    })),
    tripUpdates: updates.map((u): RefSource => ({ ref: u.ref, vehicleId: u.vehicleId })),
  });

  const serviceIds = [...new Set(trips.map((tr) => tr.row.service_id!))].sort();
  const expectedSchedule: ExpectedSchedule = {
    agency: { names: AGENCIES.map((a) => a.agency_name!), timezone: TIMEZONE },
    routes: ROUTES,
    trips: trips.map((tr) => tr.row),
    frequencies: trips.flatMap((tr) => tr.frequencies),
    tripTimes: Object.fromEntries(
      trips.flatMap((tr) => {
        const times = templateOf(tr);
        return times ? [[tr.row.trip_id!, times]] : [];
      }),
    ),
    tripsWithoutTemplate: trips.filter((tr) => !templateOf(tr)).map((tr) => tr.row.trip_id!),
    shapes: shapePolylines,
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
  const feedsAt = (seconds: number): Feeds => encodeFeeds(realtime, nowSec + seconds);
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
