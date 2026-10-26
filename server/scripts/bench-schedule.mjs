#!/usr/bin/env node
// Memory and time of loading a large synthetic GTFS Schedule (not part of `npm test`).
//
//   npm run build -w server
//   node --expose-gc server/scripts/bench-schedule.mjs [--dir DIR] [--trips 100000] [--stops 20]
//        [--shapes 4000] [--points 500] [--limit BYTES] [--ungrouped] [--keep]
//
// Generates the zip (default 100 000 trips, 2 000 000 stop times, 4 000 shapes x 500 = 2 000 000
// shape points) with a streaming writer into DIR (default: the OS temp dir), then loads it in a
// fresh process with the real parser, in 64 KiB chunks like a download, and reports peak RSS,
// the heap retained once loading is done (after a forced GC) and the loader's own estimate of it.
/* global process, console, performance, setInterval, clearInterval, setImmediate, URL, AbortController */
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Zip, ZipDeflate, strToU8 } from 'fflate';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const mode = option('mode', 'both');
const trips = Number(option('trips', 100_000));
const stops = Number(option('stops', 20));
const shapes = Number(option('shapes', 4_000));
const points = Number(option('points', 500));
const ungrouped = args.includes('--ungrouped');
const limit = Number(option('limit', 768 * 1024 * 1024));
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

async function generate(file) {
  const out = createWriteStream(file);
  const zip = new Zip((error, data) => {
    if (error) throw error;
    out.write(data);
  });
  const add = async (name, lines) => {
    const entry = new ZipDeflate(name, { level: 1 });
    zip.add(entry);
    let batch = [];
    for (const line of lines) {
      batch.push(line);
      if (batch.length >= 20_000) {
        entry.push(strToU8(batch.join('\n') + '\n'));
        batch = [];
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    entry.push(strToU8(batch.length > 0 ? batch.join('\n') + '\n' : ''), true);
  };
  const hms = (seconds) =>
    [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');

  await add('agency.txt', [
    'agency_id,agency_name,agency_url,agency_timezone,agency_lang',
    'BENCH,Bench Transit,https://bench.example/,America/Los_Angeles,en',
  ]);
  await add('routes.txt', [
    'route_id,agency_id,route_short_name,route_long_name,route_type,route_color',
    ...Array.from({ length: 400 }, (_, i) => `route_${i},BENCH,${i},Benchmark route ${i},3,0072BC`),
  ]);
  await add('calendar.txt', [
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
    'WEEKDAY,1,1,1,1,1,0,0,20260101,20261231',
    'WEEKEND,0,0,0,0,0,1,1,20260101,20261231',
  ]);
  await add('calendar_dates.txt', [
    'service_id,date,exception_type',
    ...Array.from(
      { length: 200 },
      (_, i) =>
        `WEEKDAY,2026${String(1 + (i % 12)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')},2`,
    ),
  ]);
  await add(
    'trips.txt',
    (function* () {
      yield 'route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed';
      for (let t = 0; t < trips; t++) {
        yield `route_${t % 400},${t % 3 === 0 ? 'WEEKEND' : 'WEEKDAY'},trip_${String(t).padStart(7, '0')},Downtown via Main Street ${t % 50},,${t % 2},block_${t % 900},shape_${t % shapes},1,1`;
      }
    })(),
  );
  await add(
    'frequencies.txt',
    (function* () {
      yield 'trip_id,start_time,end_time,headway_secs,exact_times';
      for (let t = 0; t < trips; t += 100) {
        yield `trip_${String(t).padStart(7, '0')},06:00:00,22:00:00,600,`;
      }
    })(),
  );
  await add(
    'stop_times.txt',
    (function* () {
      yield 'trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled';
      for (let t = 0; t < trips; t++) {
        const id = `trip_${String(t).padStart(7, '0')}`;
        const start = 5 * 3600 + (t % 1000) * 60;
        for (let s = 0; s < stops; s++) {
          const time = hms(start + s * 120);
          yield `${id},${time},${time},stop_${(t * 7 + s) % 5000},${s + 1},,0,0,${(s * 350.5).toFixed(1)}`;
        }
      }
    })(),
  );
  await add(
    'shapes.txt',
    (function* () {
      yield 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled';
      const line = (s, p) =>
        `shape_${s},${(37 + s / 10_000 + p / 20_000).toFixed(6)},${(-122 - p / 20_000 + (s % 7) / 1000).toFixed(6)},${p + 1},${(p * 12.5).toFixed(1)}`;
      // Grouped by shape_id, or (--ungrouped) point 1 of every shape, then point 2, ...
      if (ungrouped) {
        for (let p = 0; p < points; p++) for (let s = 0; s < shapes; s++) yield line(s, p);
      } else {
        for (let s = 0; s < shapes; s++) for (let p = 0; p < points; p++) yield line(s, p);
      }
    })(),
  );
  zip.end();
  await new Promise((resolve) => out.end(resolve));
}

async function load(file) {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'schedule');
  const { parseSchedule } = await import(join(root, 'parse.js'));
  const { MemoryBudget } = await import(join(root, 'memory.js'));
  const { LoadGuard } = await import(join(root, 'guard.js'));
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    chunks.push(chunk);
    size += chunk.length;
  }
  globalThis.gc();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  let worstLag = 0;
  let last = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    worstLag = Math.max(worstLag, now - last - 50);
    last = now;
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 50);
  const started = performance.now();
  const budget = new MemoryBudget(limit);
  const store = await parseSchedule(
    { chunks, size },
    budget,
    LoadGuard.unlimited(new AbortController().signal),
  );
  const seconds = (performance.now() - started) / 1000;
  clearInterval(sampler);
  chunks.length = 0;
  globalThis.gc();
  const after = process.memoryUsage();
  const counts = store.counts();
  // Shapes are held only as encoded strings.
  let sampled = 0;
  for (let s = 0; s < Math.min(shapes, 50); s++) {
    const polyline = store.shape(`shape_${s}`);
    if (typeof polyline !== 'string' || polyline.length === 0)
      throw new Error(`shape_${s} is not a string`);
    sampled++;
  }
  const retained = after.heapUsed - baseline.heapUsed;
  console.log(
    JSON.stringify(
      {
        zip: mib(size),
        trips: counts.trips,
        shapes: counts.shapes,
        loadSeconds: Number(seconds.toFixed(1)),
        peakRss: mib(peakRss),
        peakHeapUsed: mib(peakHeap),
        retainedHeapAfterGc: mib(retained),
        loaderEstimate: mib(counts.estimatedBytes),
        limit: mib(limit),
        worstEventLoopLagMs: Math.round(worstLag),
        shapesSampledAsStrings: sampled,
        underLimit: retained < limit && counts.estimatedBytes < limit,
      },
      null,
      2,
    ),
  );
}

if (mode === 'generate') {
  await generate(option('file'));
} else if (mode === 'load') {
  if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');
  await load(option('file'));
} else {
  const dir = option('dir')
    ? (mkdirSync(option('dir'), { recursive: true }), option('dir'))
    : mkdtempSync(join(tmpdir(), 'bench-schedule-'));
  const file = join(dir, 'bench-schedule.zip');
  const self = fileURLToPath(import.meta.url);
  const forward = [
    '--trips',
    trips,
    '--stops',
    stops,
    '--shapes',
    shapes,
    '--points',
    points,
    '--limit',
    limit,
    '--file',
    file,
    ...(ungrouped ? ['--ungrouped'] : []),
  ].map(String);
  console.error(
    `generating ${trips} trips x ${stops} stops, ${shapes} shapes x ${points} points ...`,
  );
  let result = spawnSync(process.execPath, [self, '--mode', 'generate', ...forward], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.error(`generated ${mib(statSync(file).size)}; loading ...`);
  result = spawnSync(process.execPath, ['--expose-gc', self, '--mode', 'load', ...forward], {
    stdio: 'inherit',
  });
  if (!args.includes('--keep')) rmSync(file, { force: true });
  process.exit(result.status ?? 1);
}
