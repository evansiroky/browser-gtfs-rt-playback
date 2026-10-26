#!/usr/bin/env node
// Time of the trip lists over a large synthetic schedule (not part of `npm test`).
//
//   npm run build -w server
//   node server/scripts/bench-trips.mjs [--trips 100000] [--vehicles 5000] [--updates 3000]
//        [--runs 30] [--zone America/Los_Angeles] [--now 2026-10-14T19:07:42Z]
//        [--frequency 0.1] [--ghost 0.06]
//
// Builds the schedule store directly (no zip: loading is benchmarked by bench-schedule.mjs), with
// the given number of trips (by default 90% plain, 10% frequency trips of 1-3 rows, a few configuration
// errors), a vehicle positions snapshot and a trip updates snapshot that reference active,
// scheduled and unknown trips, and times the first call (which builds the schedule index) and
// then `runs` calls of every list and of the dashboard on a fixed clock.
/* global process, console, performance, URL */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const tripCount = Number(option('trips', 100_000));
const vehicleCount = Number(option('vehicles', 5_000));
const updateCount = Number(option('updates', 3_000));
const runs = Number(option('runs', 30));
const frequencyShare = Number(option('frequency', 0.1));
const ghostShare = Number(option('ghost', 0.06));
const timezone = option('zone', 'America/Los_Angeles');
const now = Date.parse(option('now', '2026-10-14T19:07:42Z'));

const dist = (path) => import(fileURLToPath(new URL(`../dist/${path}`, import.meta.url)));
const require = createRequire(import.meta.url);
const { transit_realtime: rt } = require('gtfs-realtime-bindings');
const { FakeClock } = await dist('clock.js');
const { ServiceCalendar } = await dist('schedule/calendar.js');
const { MemoryScheduleStore } = await dist('schedule/memory-store.js');
const { SnapshotStore, decodeFeed } = await dist('realtime/snapshot-store.js');
const { PingStore } = await dist('trips/pings.js');
const { TripEngine } = await dist('trips/engine.js');

let seed = 12345;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const int = (low, high) => low + Math.floor(random() * (high - low + 1));
const hms = (secs) =>
  [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

const calendar = new ServiceCalendar();
const serviceIds = Array.from({ length: 60 }, (_, i) => `SVC${i}`);
for (const [i, id] of serviceIds.entries()) {
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  calendar.addWeekly({
    service_id: id,
    ...Object.fromEntries(days.map((d, k) => [d, (i + k) % 3 === 0 ? '0' : '1'])),
    start_date: '20260101',
    end_date: '20271231',
  });
}

const trips = new Map();
const errors = [];
for (let i = 0; i < tripCount; i++) {
  const id = `trip-${i}`;
  const startSecs = int(4 * 3600, 26 * 3600);
  const frequency = random() < frequencyShare;
  const rows = frequency
    ? Array.from({ length: int(1, 3) }, () => {
        const start = int(4 * 3600, 22 * 3600);
        return {
          trip_id: id,
          start_time: hms(start),
          end_time: hms(start + int(1, 6) * 3600),
          headway_secs: String(int(5, 30) * 60),
          exact_times: '0',
        };
      })
    : [];
  const unusable = i % 5000 === 0;
  if (unusable) errors.push({ code: 'unusable_stop_times', tripId: id });
  trips.set(id, {
    id,
    row: { trip_id: id, service_id: serviceIds[i % serviceIds.length], route_id: `R${i % 400}` },
    template: unusable ? null : { startSecs, endSecs: startSecs + int(10, 90) * 60 },
    frequencies: rows,
  });
}
const routes = new Map(
  Array.from({ length: 400 }, (_, i) => [
    `R${i}`,
    { route_id: `R${i}`, route_short_name: String(i), route_long_name: `Route ${i}` },
  ]),
);
const store = new MemoryScheduleStore({
  agency: { names: ['Bench'], timezone },
  routes,
  trips,
  calendar,
  shapes: new Map(),
  configurationErrors: errors,
  estimatedBytes: 0,
});

// References: mostly active trips, some scheduled ones, some unknown.
const ms = (fn) => {
  const start = performance.now();
  const result = fn();
  return [performance.now() - start, result];
};
const clock = new FakeClock(now);
const snapshots = new SnapshotStore({
  clock,
  logger: { error() {} },
  retentionMs: 3_600_000,
  memoryLimitBytes: 1 << 30,
});
const pings = new PingStore(snapshots);
const engine = new TripEngine({ clock, snapshots, pings, schedule: () => store });
const some = () => `trip-${int(0, tripCount - 1)}`;
const add = (feed, entities) => {
  const bytes = rt.FeedMessage.encode(
    rt.FeedMessage.create({
      header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(now / 1000) },
      entity: entities,
    }),
  ).finish();
  snapshots.add(feed, bytes, decodeFeed(bytes));
};
// The first call builds the schedule index (no snapshots yet); it also finds the active trips, so
// that the references mostly match.
const [first, firstResult] = ms(() => engine.list('active-without-realtime'));
const active = firstResult.trips.map((t) => t.tripId);
let ghosts = 0;
const pick = () =>
  random() < ghostShare
    ? `ghost-${ghosts++}`
    : random() < 0.7 && active.length > 0
      ? active[int(0, active.length - 1)]
      : some();
add(
  'vehiclePositions',
  Array.from({ length: vehicleCount }, (_, i) => ({
    id: `v${i}`,
    vehicle: {
      trip: { tripId: pick() },
      vehicle: { id: `bus-${i}`, label: `Bus ${i}` },
      position: { latitude: 37.7, longitude: -122.4 },
      timestamp: Math.floor(now / 1000) - int(0, 30),
    },
  })),
);
add(
  'tripUpdates',
  Array.from({ length: updateCount }, (_, i) => ({
    id: `u${i}`,
    tripUpdate: { trip: { tripId: pick() }, delay: int(-120, 600) },
  })),
);

console.log(`${tripCount} trips, ${vehicleCount} vehicles, ${updateCount} trip updates`);
console.log(`first call (builds the schedule index): ${first.toFixed(0)} ms`);
const summary = (label, samples) => {
  samples.sort((a, b) => a - b);
  const at = (p) => samples[Math.min(samples.length - 1, Math.ceil(p * samples.length) - 1)];
  console.log(
    `${label.padEnd(28)} p50 ${at(0.5).toFixed(0)} ms  p95 ${at(0.95).toFixed(0)} ms  max ${samples.at(-1).toFixed(0)} ms`,
  );
  return at(0.95);
};
let worst = 0;
for (const list of [
  'active-with-realtime',
  'active-without-realtime',
  'unscheduled-with-realtime',
]) {
  const samples = [];
  let rows = 0;
  for (let i = 0; i < runs; i++) {
    const [time, result] = ms(() => engine.list(list));
    samples.push(time);
    rows = result.trips.length;
  }
  worst = Math.max(worst, summary(`${list} (${rows} rows)`, samples));
}
const dashboard = [];
for (let i = 0; i < runs; i++) dashboard.push(ms(() => engine.dashboard())[0]);
worst = Math.max(worst, summary('dashboard', dashboard));
const detail = [];
for (let i = 0; i < runs; i++)
  detail.push(ms(() => engine.detail(active[i % active.length] ?? 'trip-1'))[0]);
summary('detail', detail);
console.log(`worst p95 of the lists and dashboard: ${worst.toFixed(0)} ms (target: under 300 ms)`);
