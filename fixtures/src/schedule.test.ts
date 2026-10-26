import { decodePolyline6, encodePolyline6, type LatLng } from '@gtfs-rt-debugger/shared';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TIMEZONE } from './catalog.js';
import { toCsv, type Row } from './csv.js';
import { scenario } from './scenario.js';
import type { TripData } from './schedule.js';
import { agencyInstant, parseHms } from './time.js';

/** A small RFC 4180 reader, independent of the writer under test. */
function parseCsv(text: string): Row[] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(cell);
      cell = '';
    } else if (c === '\n') {
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else cell += c;
  }
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]!])));
}

const sc = scenario(agencyInstant('20261014', '12:07:42', TIMEZONE));
const files = unzipSync(sc.scheduleZip);
const table = (name: string): Row[] => parseCsv(strFromU8(files[name]!));

describe('csv writer', () => {
  it('quotes commas, quotes and newlines, and writes missing columns empty', () => {
    const csv = toCsv(
      ['a', 'b', 'c'],
      [
        { a: 'x,y', b: 'say "hi"' },
        { a: 'two\nlines', c: '1' },
      ],
    );
    expect(csv).toBe('a,b,c\n"x,y","say ""hi""",\n"two\nlines",,1\n');
    expect(parseCsv(csv)).toEqual([
      { a: 'x,y', b: 'say "hi"', c: '' },
      { a: 'two\nlines', b: '', c: '1' },
    ]);
  });
});

describe('schedule zip', () => {
  it('holds every file the loader reads, plus stops.txt it discards', () => {
    expect(Object.keys(files).sort()).toEqual([
      'agency.txt',
      'calendar.txt',
      'calendar_dates.txt',
      'frequencies.txt',
      'routes.txt',
      'shapes.txt',
      'stop_times.txt',
      'stops.txt',
      'trips.txt',
    ]);
  });

  it('is identical every time it is built', () => {
    expect(scenario(agencyInstant('20261014', '12:07:42', TIMEZONE)).scheduleZip).toEqual(
      sc.scheduleZip,
    );
  });

  it('describes the agency, its timezone and both agency names', () => {
    const agencies = table('agency.txt');
    expect(agencies.map((a) => a.agency_name)).toEqual(sc.expected.schedule.agency.names);
    expect(new Set(agencies.map((a) => a.agency_timezone))).toEqual(new Set([TIMEZONE]));
    expect(sc.expected.schedule.agency.names).toEqual(['Fixture Transit', 'Fixture Express']);
  });

  it('keeps every route and trips column, including values that need quoting', () => {
    expect(table('routes.txt')).toEqual(sc.expected.schedule.routes);
    expect(table('trips.txt')).toEqual(sc.expected.schedule.trips);
    expect(table('routes.txt')[2]!.route_long_name).toBe('Embarcadero "Night" Express');
    expect(table('trips.txt')[0]!.trip_headsign).toBe('Downtown, via Market');
  });

  it('writes frequencies.txt rows as the expectation lists them, with exact_times as sent', () => {
    const rows = table('frequencies.txt');
    expect(rows).toEqual(sc.expected.schedule.frequencies);
    const exactByTrip = (id: string): string[] =>
      rows.filter((r) => r.trip_id === id).map((r) => r.exact_times!);
    expect(exactByTrip('freq-exact')).toEqual(['1']);
    expect(exactByTrip('freq-nominal')).toEqual(['0', '']);
    expect(exactByTrip('freq-mixed')).toEqual(['1', '']);
  });

  it('writes first and last stop times that match the expected template or span', () => {
    const byTrip = new Map<string, Row[]>();
    for (const row of table('stop_times.txt')) {
      byTrip.set(row.trip_id!, [...(byTrip.get(row.trip_id!) ?? []), row]);
    }
    const secs = (v: string | undefined): number | null => (v ? parseHms(v) : null);
    const { tripTimes, tripsWithoutTemplate } = sc.expected.schedule;
    for (const [tripId, rows] of byTrip) {
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const startSecs = secs(first.departure_time) ?? secs(first.arrival_time);
      const endSecs = secs(last.arrival_time) ?? secs(last.departure_time);
      if (startSecs === null || endSecs === null) {
        expect(tripsWithoutTemplate, tripId).toContain(tripId);
      } else {
        expect({ startSecs, endSecs }, tripId).toEqual(tripTimes[tripId]);
      }
    }
    expect(Object.keys(tripTimes).length + tripsWithoutTemplate.length).toBe(
      sc.schedule.trips.length,
    );
    // The trips without a template: no rows at all, no time at the last stop, no time at the first.
    expect(tripsWithoutTemplate).toEqual([
      'cfg-no-stop-times',
      'cfg-last-stop-untimed',
      'cfg-freq-first-stop-untimed',
      'cfg-mixed-and-no-stop-times',
    ]);
    expect(byTrip.has('cfg-no-stop-times')).toBe(false);
    expect(byTrip.get('cfg-last-stop-untimed')!.at(-1)).toMatchObject({
      arrival_time: '',
      departure_time: '',
    });
    expect(byTrip.get('cfg-freq-first-stop-untimed')![0]).toMatchObject({
      arrival_time: '',
      departure_time: '',
    });
  });

  it('exercises dwell at terminals and arrival-only / departure-only times', () => {
    const rows = table('stop_times.txt');
    const of = (id: string): Row[] => rows.filter((r) => r.trip_id === id);
    const dwell = of('plain-active-vp');
    expect(parseHms(dwell[0]!.arrival_time!)).toBeLessThan(parseHms(dwell[0]!.departure_time!));
    expect(parseHms(dwell[4]!.departure_time!)).toBeGreaterThan(parseHms(dwell[4]!.arrival_time!));
    const partial = of('plain-active-tu');
    expect(partial[0]!.departure_time).toBe('');
    expect(partial[4]!.arrival_time).toBe('');
  });

  it('keeps blocks free of overlapping trips', () => {
    const times = new Map<string, [number, number]>();
    for (const [tripId, { startSecs, endSecs }] of Object.entries(sc.expected.schedule.tripTimes)) {
      times.set(tripId, [startSecs, endSecs]);
    }
    const blocks = new Map<string, TripData[]>();
    for (const t of sc.schedule.trips.filter((t) => t.row.block_id)) {
      const key = `${t.row.block_id}/${t.row.service_id}`;
      blocks.set(key, [...(blocks.get(key) ?? []), t]);
    }
    expect(blocks.size).toBeGreaterThan(0);
    for (const trips of blocks.values()) {
      const spans = trips.map((t) => times.get(t.row.trip_id!)!).sort((a, b) => a[0] - b[0]);
      spans.forEach((span, i) => {
        if (i > 0) expect(span[0]).toBeGreaterThanOrEqual(spans[i - 1]![1]);
      });
    }
  });

  it('has times past 24:00:00 for the overnight trips, and a window that crosses midnight', () => {
    const windows = table('frequencies.txt').filter((r) => r.trip_id === 'freq-overnight');
    expect(windows).toEqual([
      {
        trip_id: 'freq-overnight',
        start_time: '23:00:00',
        end_time: '25:00:00',
        headway_secs: '600',
        exact_times: '0',
      },
    ]);
    expect(
      table('stop_times.txt').find(
        (r) => r.trip_id === 'overnight-daily' && r.stop_sequence === '5',
      )?.arrival_time,
    ).toBe('25:30:00');
  });

  it('has times past 24:00:00 for the overnight trip', () => {
    const rows = table('stop_times.txt').filter((r) => r.trip_id === 'overnight-from-yesterday');
    expect(rows[0]!.departure_time).toBe('23:30:00');
    expect(rows[4]!.arrival_time).toBe('25:30:00');
  });

  it('puts the calendar and its exceptions where the expectation says they operate', () => {
    expect(table('calendar.txt').map((r) => r.service_id)).toEqual([
      'DAILY',
      'REMOVED_TODAY',
      'OFFDAY',
      'NIGHT',
    ]);
    expect(table('calendar_dates.txt')).toEqual([
      { service_id: 'REMOVED_TODAY', date: '20261014', exception_type: '2' },
      { service_id: 'ADDED_TODAY', date: '20261014', exception_type: '1' },
    ]);
    expect(sc.expected.schedule.operates).toEqual({
      ADDED_TODAY: { yesterday: false, today: true },
      DAILY: { yesterday: true, today: true },
      NIGHT: { yesterday: true, today: false },
      OFFDAY: { yesterday: false, today: false },
      REMOVED_TODAY: { yesterday: true, today: false },
    });
  });
});

describe('shapes', () => {
  const rows = table('shapes.txt');
  const ids = rows.map((r) => r.shape_id!);
  const shapeIds = [...new Set(ids)].sort();

  it('has at least three shapes of at least twenty points', () => {
    expect(shapeIds).toEqual([
      'shape-embarcadero',
      'shape-market',
      'shape-mission',
      'shape-vanness',
    ]);
    for (const id of shapeIds)
      expect(ids.filter((i) => i === id).length).toBeGreaterThanOrEqual(20);
    for (const r of rows) {
      expect(Number(r.shape_pt_lat)).toBeGreaterThan(37.7);
      expect(Number(r.shape_pt_lat)).toBeLessThan(37.82);
      expect(Number(r.shape_pt_lon)).toBeGreaterThan(-122.5);
      expect(Number(r.shape_pt_lon)).toBeLessThan(-122.38);
    }
  });

  it('is not grouped by shape_id, and one shape is out of sequence order', () => {
    const runs = (id: string): number => ids.filter((v, i) => v === id && ids[i - 1] !== id).length;
    expect(runs('shape-market')).toBe(1);
    expect(runs('shape-vanness')).toBe(1);
    expect(runs('shape-mission')).toBeGreaterThan(1);
    expect(runs('shape-embarcadero')).toBeGreaterThan(1);
    const sequence = (id: string): number[] =>
      rows.filter((r) => r.shape_id === id).map((r) => Number(r.shape_pt_sequence));
    expect(sequence('shape-mission')).not.toEqual(
      [...sequence('shape-mission')].sort((a, b) => a - b),
    );
    expect(sequence('shape-market')).toEqual(sequence('shape-market').toSorted((a, b) => a - b));
  });

  it('encodes, once sorted by sequence, to the polylines in the expectation', () => {
    for (const id of shapeIds) {
      const points = rows
        .filter((r) => r.shape_id === id)
        .sort((a, b) => Number(a.shape_pt_sequence) - Number(b.shape_pt_sequence))
        .map((r): LatLng => [Number(r.shape_pt_lat), Number(r.shape_pt_lon)]);
      expect(encodePolyline6(points), id).toBe(sc.expected.schedule.shapes[id]);
      expect(decodePolyline6(sc.expected.schedule.shapes[id]!)).toHaveLength(points.length);
    }
    expect(Object.keys(sc.expected.schedule.shapes).sort()).toEqual(shapeIds);
  });

  it('would encode differently if the file order were trusted', () => {
    const inFileOrder = rows
      .filter((r) => r.shape_id === 'shape-mission')
      .map((r): LatLng => [Number(r.shape_pt_lat), Number(r.shape_pt_lon)]);
    expect(encodePolyline6(inFileOrder)).not.toBe(sc.expected.schedule.shapes['shape-mission']);
  });

  it('leaves one trip pointing at a shape that does not exist', () => {
    expect(sc.expected.schedule.tripsWithoutShape).toEqual(['plain-active-missing-shape']);
    expect(shapeIds).not.toContain('shape-gone');
  });
});
