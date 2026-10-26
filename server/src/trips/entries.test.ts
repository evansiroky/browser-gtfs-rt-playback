import { serviceDayStart as fixtureDayStart } from '@gtfs-rt-debugger/fixtures';
import { describe, expect, it } from 'vitest';
import { ServiceCalendar } from '../schedule/calendar.js';
import { MemoryScheduleStore } from '../schedule/memory-store.js';
import type { Row, ScheduleConfigurationError, ScheduleTrip } from '../schedule/store.js';
import { readFrequencyRow, tooDense } from '../schedule/frequency.js';
import { parseGtfsTime } from '../schedule/time.js';
import {
  activeEntries,
  countActive,
  Frame,
  parseFrequencyRows,
  readableWindows,
  scheduledToday,
} from './entries.js';
import { addDays, agencyDate } from './time.js';

/** A small deterministic generator, so a failure names a reproducible case. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const hms = (secs: number): string =>
  [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

function buildStore(seed: number, tripCount: number, timezone: string) {
  const rnd = random(seed);
  const int = (low: number, high: number): number => low + Math.floor(rnd() * (high - low + 1));
  const calendar = new ServiceCalendar();
  const services = ['DAILY', 'WEEKDAY', 'WEEKEND', 'GONE', 'ADDED'];
  const flags = (days: string) =>
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d, i) => [
      d,
      days[i]!,
    ]);
  for (const [id, days, end] of [
    ['DAILY', '1111111', '20301231'],
    ['WEEKDAY', '1111100', '20301231'],
    ['WEEKEND', '0000011', '20301231'],
    ['GONE', '1111111', '20200101'],
  ] as const) {
    calendar.addWeekly({
      service_id: id,
      ...Object.fromEntries(flags(days)),
      start_date: '20200101',
      end_date: end,
    });
  }
  for (const date of ['20260307', '20260308', '20261031', '20261101', '20261014']) {
    calendar.addException({ service_id: 'ADDED', date, exception_type: '1' });
    calendar.addException({ service_id: 'DAILY', date, exception_type: rnd() < 0.3 ? '2' : '1' });
  }
  const trips = new Map<string, ScheduleTrip>();
  const errors: ScheduleConfigurationError[] = [];
  for (let i = 0; i < tripCount; i++) {
    const id = `t${i}`;
    const startSecs = int(0, 30 * 3600);
    const length =
      rnd() < 0.02 ? int(-600, 0) : rnd() < 0.05 ? int(0, 40 * 3600) : int(0, 3 * 3600);
    const frequency = rnd() < 0.25;
    const rows: Row[] = [];
    if (frequency) {
      for (let r = int(1, 3); r > 0; r--) {
        // half of the rows sit on a common hourly grid, so rows overlap on the same instants
        const aligned = rnd() < 0.5;
        const windowStart = aligned ? int(0, 26) * 3600 : int(0, 26 * 3600);
        const length = rnd() < 0.1 ? int(20 * 3600, 34 * 3600) : int(-600, 8 * 3600);
        rows.push({
          trip_id: id,
          start_time: rnd() < 0.05 ? 'bad' : hms(windowStart),
          end_time: hms(windowStart + length),
          headway_secs:
            rnd() < 0.05
              ? '0'
              : String(aligned ? [600, 1200, 3600][int(0, 2)]! : int(1, 4) * int(60, 1800)),
          exact_times: ['', '0', '1'][int(0, 2)]!,
        });
      }
    }
    const unusable = rnd() < 0.03;
    if (unusable) errors.push({ code: 'unusable_stop_times', tripId: id });
    else {
      if (new Set(rows.map((r) => r['exact_times'] || '0')).size > 1) {
        errors.push({ code: 'mixed_exact_times', tripId: id });
      }
      const dense = rows.some((row) => {
        const { startSecs: from, endSecs: to, headwaySecs } = readFrequencyRow(row);
        return (
          from !== null && to !== null && headwaySecs !== null && tooDense(length, headwaySecs)
        );
      });
      if (dense) errors.push({ code: 'frequency_too_dense', tripId: id });
    }
    trips.set(id, {
      id,
      row: { trip_id: id, service_id: services[int(0, 4)]!, route_id: 'R1' },
      template: unusable ? null : { startSecs, endSecs: startSecs + length },
      frequencies: rows,
    });
  }
  return new MemoryScheduleStore({
    agency: { names: ['X'], timezone },
    routes: new Map(),
    trips,
    calendar,
    shapes: new Map(),
    configurationErrors: errors,
    estimatedBytes: 0,
  });
}

/**
 * Every entry of the schedule on a service date, written out in the most direct way: a plain trip
 * is one entry, an instance is identified by its trip and start instant and described by the
 * first row that produces it.
 */
function naiveEntries(
  store: MemoryScheduleStore,
  date: string,
  timeZone: string,
  tally?: { repeated: number },
) {
  const errors = new Set(store.configurationErrors().map((e) => e.tripId));
  const dayStart = fixtureDayStart(date, timeZone).getTime() / 1000;
  const entries = new Map<string, { start: number; end: number }>();
  for (const trip of store.trips()) {
    if (errors.has(trip.id) || !trip.template) continue;
    if (!store.operatesOn(trip.row['service_id']!, date)) continue;
    const duration = trip.template.endSecs - trip.template.startSecs;
    if (trip.frequencies.length === 0) {
      entries.set(trip.id, {
        start: dayStart + trip.template.startSecs,
        end: dayStart + trip.template.endSecs,
      });
      continue;
    }
    for (const row of trip.frequencies) {
      const start = parseGtfsTime(row['start_time']);
      const end = parseGtfsTime(row['end_time']);
      const headway = Number(row['headway_secs']);
      if (start === null || end === null || !(headway > 0)) continue;
      for (let s = start; s < end; s += headway) {
        const key = `${trip.id}@${dayStart + s}`;
        if (entries.has(key)) {
          if (tally) tally.repeated++;
        } else entries.set(key, { start: dayStart + s, end: dayStart + s + duration });
      }
    }
  }
  return entries;
}

describe('the index finds exactly the active entries of a naive scan', () => {
  it.each([
    [1, 'America/Los_Angeles'],
    [2, 'Europe/London'],
    [3, 'Asia/Kolkata'],
    [4, 'Australia/Lord_Howe'],
  ])('seed %i in %s', (seed, timeZone) => {
    const store = buildStore(seed, 1500, timeZone);
    const rnd = random(seed * 7919);
    const instants = [
      '2026-03-08T07:30:00Z',
      '2026-03-08T10:00:30Z',
      '2026-11-01T08:15:00Z',
      '2026-11-01T09:15:00Z',
      '2026-10-14T07:20:00Z',
      '2026-10-14T19:07:42Z',
      ...Array.from({ length: 60 }, () =>
        new Date(Date.UTC(2026, 2, 1) + rnd() * 270 * 86_400_000).toISOString(),
      ),
    ];
    let active = 0;
    const tally = { repeated: 0 };
    let crossDate = 0;
    for (const iso of instants) {
      const nowMs = Date.parse(iso);
      const frame = new Frame(store, nowMs);
      const today = agencyDate(nowMs, timeZone);
      const minute = Math.floor(nowMs / 60_000) * 60;

      // the later date replaces the earlier for an entry active on both
      const expected = new Map<string, string>();
      for (const date of [addDays(today, -1), today]) {
        for (const [key, e] of naiveEntries(store, date, timeZone, tally)) {
          if (e.start < minute + 60 && e.end >= minute) {
            if (expected.has(key)) crossDate++;
            expected.set(key, `${key}@${date}`);
          }
        }
      }
      const got = new Map(
        activeEntries(frame).map((e) => {
          const key = e.window ? `${e.tripId}@${e.start}` : e.tripId;
          return [key, `${key}@${e.date}`] as const;
        }),
      );
      expect([...got.values()].sort(), iso).toEqual([...expected.values()].sort());
      expect(got.size, `${iso}: no entry twice`).toBe(activeEntries(frame).length);
      expect(countActive(new Frame(store, nowMs)), `${iso}: counted without making entries`).toBe(
        expected.size,
      );
      expect(scheduledToday(frame), iso).toBe(naiveEntries(store, today, timeZone).size);
      active += got.size;
    }
    // the generator produces something to compare, including instants produced twice
    expect(active).toBeGreaterThan(100);
    expect(tally.repeated).toBeGreaterThan(0);
    expect(crossDate).toBeGreaterThan(0);
  });
});

describe('parseFrequencyRows', () => {
  it('keeps every row, with its position, and nulls what cannot be read', () => {
    const rows: Row[] = [
      { start_time: '06:00:00', end_time: '07:00:00', headway_secs: '600', exact_times: '1' },
      { start_time: 'x', end_time: '07:00:00', headway_secs: '600' },
      { start_time: '06:00:00', end_time: '07:00:00', headway_secs: ' 900 ', exact_times: ' 0 ' },
      { start_time: '06:00:00', end_time: '07:00:00', headway_secs: '12.5' },
      { start_time: '06:00:00', end_time: '06:00:00', headway_secs: '60' },
      { start_time: '6:00:00', end_time: '25:30:00', headway_secs: '3600' },
    ];
    expect(
      parseFrequencyRows(rows).map((w) => [
        w.rowIndex,
        w.startSecs,
        w.endSecs,
        w.headwaySecs,
        w.exactTimes,
        w.count,
      ]),
    ).toEqual([
      [0, 21600, 25200, 600, true, 6],
      [1, null, 25200, 600, false, 0],
      [2, 21600, 25200, 900, false, 4],
      [3, 21600, 25200, null, false, 0],
      [4, 21600, 21600, 60, false, 0],
      [5, 21600, 91800, 3600, false, 20],
    ]);
    expect(readableWindows(rows).map((w) => w.rowIndex)).toEqual([0, 2, 4, 5]);
  });
});
