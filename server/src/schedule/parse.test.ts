import { scenario } from '@gtfs-rt-debugger/fixtures';
import { describe, expect, it } from 'vitest';
import { MemoryBudget } from './memory.js';
import { parseSchedule } from './parse.js';
import { chunked, miniSchedule, zipOf } from '../test-support/zip.js';

const NOW = new Date('2026-10-14T19:07:42Z');
const LIMIT = 768 * 1024 * 1024;
const signal = new AbortController().signal;

async function parseFixture(chunkSize?: number) {
  const sc = scenario(NOW);
  const store = await parseSchedule(
    chunked(sc.scheduleZip, chunkSize),
    new MemoryBudget(LIMIT),
    signal,
  );
  return { sc, store };
}

describe.each([
  ['one chunk', undefined],
  ['small chunks', 997],
])('parsing the fixture schedule (%s)', (_name, chunkSize) => {
  it('keeps the agency names and the first row timezone', async () => {
    const { sc, store } = await parseFixture(chunkSize);
    expect(store.agency()).toEqual(sc.expected.schedule.agency);
    expect(store.agency().names).toHaveLength(2);
  });

  it('keeps every route, trip and frequency row with all columns', async () => {
    const { sc, store } = await parseFixture(chunkSize);
    const { routes, trips, frequencies } = sc.expected.schedule;
    for (const route of routes) expect(store.route(route.route_id!)).toEqual(route);
    expect(store.route('nope')).toBeUndefined();
    expect([...store.trips()].map((trip) => trip.row)).toEqual(trips);
    for (const trip of trips) expect(store.trip(trip.trip_id!)).toEqual(trip);
    expect([...store.trips()].flatMap((trip) => trip.frequencies)).toEqual(frequencies);
    expect(frequencies.length).toBeGreaterThan(0);
  });

  it('keeps each trip first and last stop time as its template, including past 24:00', async () => {
    const { sc, store } = await parseFixture(chunkSize);
    const { tripTimes } = sc.expected.schedule;
    for (const [tripId, times] of Object.entries(tripTimes)) {
      expect(store.template(tripId), tripId).toEqual(times);
    }
    expect(Math.max(...Object.values(tripTimes).map((t) => t.endSecs))).toBeGreaterThan(86_400);
    expect(store.counts().trips).toBe(Object.keys(tripTimes).length);
  });

  it('encodes every shape to the polyline the fixture expects, grouped or not', async () => {
    const { sc, store } = await parseFixture(chunkSize);
    const { shapes, tripsWithoutShape } = sc.expected.schedule;
    expect(Object.keys(shapes)).toHaveLength(4);
    for (const [shapeId, polyline] of Object.entries(shapes)) {
      expect(store.shape(shapeId), shapeId).toBe(polyline);
    }
    expect(store.counts().shapes).toBe(4);
    expect(store.shape('shape-gone')).toBeNull();
    const withoutShape = [...store.trips()]
      .filter((trip) => store.shape(trip.row['shape_id'] ?? '') === null)
      .map((trip) => trip.id);
    expect(withoutShape).toEqual(tripsWithoutShape);
    expect(withoutShape.length).toBeGreaterThan(0);
  });

  it('answers which services operate yesterday and today', async () => {
    const { sc, store } = await parseFixture(chunkSize);
    const { today, yesterday } = sc.expected;
    for (const [serviceId, operates] of Object.entries(sc.expected.schedule.operates)) {
      expect(store.operatesOn(serviceId, yesterday), `${serviceId} yesterday`).toBe(
        operates.yesterday,
      );
      expect(store.operatesOn(serviceId, today), `${serviceId} today`).toBe(operates.today);
    }
  });

  it('lists the trips whose frequency rows mix exact_times', async () => {
    const { sc, store } = await parseFixture(chunkSize);
    expect(store.configurationErrors()).toEqual(sc.expected.configurationErrors);
    expect(store.configurationErrors().length).toBeGreaterThan(0);
    const without = scenario(NOW, { includeMisconfiguredTrip: false });
    const clean = await parseSchedule(
      chunked(without.scheduleZip),
      new MemoryBudget(LIMIT),
      signal,
    );
    expect(clean.configurationErrors()).toEqual([]);
  });
});

async function load(files: Record<string, string>, limit = LIMIT) {
  return parseSchedule(chunked(zipOf(files), 512), new MemoryBudget(limit), signal);
}

async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { code: string; message: string },
  );
  expect(error, 'expected the load to fail').not.toBeNull();
  return error!;
}

const STOP_TIMES = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n';

describe('required and optional files', () => {
  it.each(['agency.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'])(
    'fails with missing_file naming %s when it is absent',
    async (name) => {
      const error = await failure(load(miniSchedule({ [name]: null })));
      expect(error.code).toBe('missing_file');
      expect(error.message).toContain(name);
    },
  );

  it('fails when neither calendar.txt nor calendar_dates.txt is present', async () => {
    const error = await failure(load(miniSchedule({ 'calendar.txt': null })));
    expect(error.code).toBe('missing_file');
    expect(error.message).toContain('calendar');
  });

  it('loads with only calendar_dates.txt, or only calendar.txt', async () => {
    const datesOnly = await load(
      miniSchedule({
        'calendar.txt': null,
        'calendar_dates.txt': 'service_id,date,exception_type\nWK,20261014,1\n',
      }),
    );
    expect(datesOnly.operatesOn('WK', '20261014')).toBe(true);
    expect(datesOnly.operatesOn('WK', '20261015')).toBe(false);
    const calendarOnly = await load(miniSchedule());
    expect(calendarOnly.operatesOn('WK', '20261014')).toBe(true);
  });

  it('loads without frequencies.txt and shapes.txt: no frequency trips, no shapes', async () => {
    const store = await load(miniSchedule({ 'shapes.txt': null }));
    expect(store.frequencies('T1')).toEqual([]);
    expect(store.shape('S1')).toBeNull();
    expect(store.counts()).toMatchObject({ trips: 1, shapes: 0 });
    expect(store.trip('T1')).toEqual({
      route_id: 'R1',
      service_id: 'WK',
      trip_id: 'T1',
      shape_id: 'S1',
    });
  });

  it('ignores every other file in the zip', async () => {
    const store = await load(
      miniSchedule({
        'stops.txt': 'stop_id\nA\n',
        'README.md': 'hello',
        'fare_rules.txt': '\u0000\u0001',
      }),
    );
    expect(store.counts().trips).toBe(1);
  });
});

describe('templates', () => {
  const trips = 'route_id,service_id,trip_id\nR1,WK,T1\nR1,WK,T2\nR1,WK,T3\nR1,WK,T4\nR1,WK,T5\n';

  it('takes the stops with the lowest and highest stop_sequence of an unsorted file', async () => {
    const store = await load(
      miniSchedule({
        'trips.txt': trips,
        'stop_times.txt':
          STOP_TIMES +
          'T1,09:00:00,09:01:00,C,3\nT1,08:00:00,08:02:00,A,1\nT1,08:30:00,08:31:00,B,2\n' +
          'T2,10:00:00,10:00:00,A,10\nT2,09:00:00,09:00:00,B,2\n',
      }),
    );
    expect(store.template('T1')).toEqual({ startSecs: 8 * 3600 + 120, endSecs: 9 * 3600 });
    expect(store.template('T2')).toEqual({ startSecs: 9 * 3600, endSecs: 10 * 3600 });
  });

  it('falls back to the arrival at the start and the departure at the end', async () => {
    const store = await load(
      miniSchedule({
        'trips.txt': trips,
        'stop_times.txt':
          STOP_TIMES +
          'T1,08:00:00,,A,1\nT1,,08:30:00,B,2\n' +
          'T2,07:00:00,07:05:00,A,1\nT2,08:00:00,08:10:00,B,2\n',
      }),
    );
    expect(store.template('T1')).toEqual({ startSecs: 28_800, endSecs: 30_600 });
    expect(store.template('T2')).toEqual({ startSecs: 7 * 3600 + 300, endSecs: 8 * 3600 });
  });

  it('reads times past 24:00:00, with one or two digit hours', async () => {
    const store = await load(
      miniSchedule({
        'trips.txt': trips,
        'stop_times.txt':
          STOP_TIMES +
          'T1,23:30:00,23:30:00,A,1\nT1,25:30:00,25:30:00,B,2\nT2,5:00:00,5:00:00,A,1\nT2,48:00:01,48:00:01,B,2\n',
      }),
    );
    expect(store.template('T1')).toEqual({ startSecs: 84_600, endSecs: 91_800 });
    expect(store.template('T2')).toEqual({ startSecs: 18_000, endSecs: 172_801 });
  });

  it('records a trip without a usable start or end as template null', async () => {
    const store = await load(
      miniSchedule({
        'trips.txt': trips,
        'stop_times.txt':
          STOP_TIMES +
          // T1: first stop has no times. T2: last stop has none. T3: malformed time.
          'T1,,,A,1\nT1,08:30:00,08:30:00,B,2\n' +
          'T2,08:00:00,08:00:00,A,1\nT2,,,B,2\n' +
          'T3,soon,soon,A,1\nT3,08:30:00,08:30:00,B,2\n',
      }),
    );
    for (const id of ['T1', 'T2', 'T3', 'T4']) expect(store.template(id), id).toBeNull();
    expect(store.trip('T4')).toBeDefined();
    expect([...store.trips()].map((trip) => trip.template)).toEqual([null, null, null, null, null]);
  });

  it('ignores stop_times of unknown trips and rows without a numeric stop_sequence', async () => {
    const store = await load(
      miniSchedule({
        'stop_times.txt':
          STOP_TIMES +
          'GHOST,01:00:00,01:00:00,A,1\nT1,02:00:00,02:00:00,A,\nT1,08:00:00,08:00:00,A,1\nT1,09:00:00,09:00:00,B,2\n',
      }),
    );
    expect(store.template('T1')).toEqual({ startSecs: 28_800, endSecs: 32_400 });
    expect(store.template('GHOST')).toBeNull();
    expect(store.trip('GHOST')).toBeUndefined();
  });
});

describe('frequencies and configuration errors', () => {
  const trips = 'route_id,service_id,trip_id\nR1,WK,F1\nR1,WK,F2\nR1,WK,F3\nR1,WK,F4\nR1,WK,F5\n';
  const header = 'trip_id,start_time,end_time,headway_secs,exact_times\n';

  async function withFrequencies(rows: string) {
    return load(miniSchedule({ 'trips.txt': trips, 'frequencies.txt': header + rows }));
  }

  it('flags only trips whose rows disagree, counting an absent exact_times as 0', async () => {
    const store = await withFrequencies(
      [
        'F1,06:00:00,09:00:00,600,0', // 0 and absent: equal
        'F1,09:00:00,12:00:00,900,',
        'F2,06:00:00,09:00:00,600,1', // 1 and 0: mixed
        'F2,09:00:00,12:00:00,900,0',
        'F3,06:00:00,09:00:00,600,', // absent and 1: mixed
        'F3,09:00:00,12:00:00,900,1',
        'F4,06:00:00,09:00:00,600,1', // a single row never disagrees with itself
        'F5,06:00:00,09:00:00,600,1',
        'F5,09:00:00,12:00:00,900,1',
        '',
      ].join('\n'),
    );
    expect(store.configurationErrors()).toEqual([
      { code: 'mixed_exact_times', tripId: 'F2' },
      { code: 'mixed_exact_times', tripId: 'F3' },
    ]);
  });

  it('keeps the whole rows in file order and drops rows of unknown trips', async () => {
    const store = await withFrequencies(
      'F1,06:00:00,09:00:00,600,0\nGHOST,06:00:00,09:00:00,600,0\nF1,09:00:00,12:00:00,900,\n',
    );
    expect(store.frequencies('F1')).toEqual([
      {
        trip_id: 'F1',
        start_time: '06:00:00',
        end_time: '09:00:00',
        headway_secs: '600',
        exact_times: '0',
      },
      {
        trip_id: 'F1',
        start_time: '09:00:00',
        end_time: '12:00:00',
        headway_secs: '900',
        exact_times: '',
      },
    ]);
    expect(store.frequencies('GHOST')).toEqual([]);
    expect(store.frequencies('F2')).toEqual([]);
  });
});

describe('agency, routes and trips', () => {
  it('keeps every agency name and uses the first row timezone', async () => {
    const store = await load(
      miniSchedule({
        'agency.txt':
          'agency_id,agency_name,agency_timezone\nA,First,Europe/Paris\nB,Second,Asia/Tokyo\n',
      }),
    );
    expect(store.agency()).toEqual({ names: ['First', 'Second'], timezone: 'Europe/Paris' });
  });

  it.each([
    ['no rows', 'agency_name,agency_timezone\n'],
    ['an empty timezone', 'agency_name,agency_timezone\nA,\n'],
    ['an unknown timezone', 'agency_name,agency_timezone\nA,Mars/Olympus\n'],
  ])('rejects an agency.txt with %s', async (_label, agency) => {
    const error = await failure(load(miniSchedule({ 'agency.txt': agency })));
    expect(error.code).toBe('invalid_schedule');
    expect(error.message).toContain('agency.txt');
  });

  it('rejects a trips.txt without a service_id column, naming file and column', async () => {
    const error = await failure(load(miniSchedule({ 'trips.txt': 'route_id,trip_id\nR1,T1\n' })));
    expect(error).toMatchObject({ code: 'invalid_schedule' });
    expect(error.message).toMatch(/trips\.txt.*service_id/);
  });

  it('keeps the first of duplicate route or trip ids', async () => {
    const store = await load(
      miniSchedule({
        'routes.txt': 'route_id,route_short_name\nR1,first\nR1,second\n',
        'trips.txt': 'route_id,service_id,trip_id,trip_headsign\nR1,WK,T1,first\nR1,WK,T1,second\n',
      }),
    );
    expect(store.route('R1')).toEqual({ route_id: 'R1', route_short_name: 'first' });
    expect(store.trip('T1')?.['trip_headsign']).toBe('first');
    expect(store.counts()).toMatchObject({ trips: 1, routes: 1 });
  });
});

describe('failures', () => {
  it('rejects a body that is not a zip as bad_zip', async () => {
    const bytes = new TextEncoder().encode('<html>Not Found</html>'.repeat(10));
    const error = await failure(parseSchedule(chunked(bytes), new MemoryBudget(LIMIT), signal));
    expect(error.code).toBe('bad_zip');
  });

  it('rejects a truncated zip as bad_zip', async () => {
    const bytes = zipOf(miniSchedule());
    const error = await failure(
      parseSchedule(chunked(bytes.subarray(0, bytes.length - 40)), new MemoryBudget(LIMIT), signal),
    );
    expect(error.code).toBe('bad_zip');
  });

  it('rejects an entry whose compressed data is corrupt as bad_zip', async () => {
    const files = miniSchedule({
      'trips.txt': 'route_id,service_id,trip_id\n' + 'R1,WK,T1\n'.repeat(200),
    });
    const bytes = zipOf(files).slice();
    // The first entry (agency.txt) starts after a 30 + name length header; scramble its data.
    const dataStart = 30 + 'agency.txt'.length;
    for (let i = 0; i < 12; i++) bytes[dataStart + i] = 0xff;
    const error = await failure(parseSchedule(chunked(bytes), new MemoryBudget(LIMIT), signal));
    expect(error.code).toBe('bad_zip');
    expect(error.message).toContain('agency.txt');
  });

  it('rejects a malformed CSV as bad_csv naming the file', async () => {
    const error = await failure(load(miniSchedule({ 'routes.txt': 'route_id\n"unterminated\n' })));
    expect(error.code).toBe('bad_csv');
    expect(error.message).toContain('routes.txt');
  });

  it('aborts with too_large when the retained data exceeds the memory limit', async () => {
    const trips =
      'route_id,service_id,trip_id\n' +
      Array.from({ length: 2000 }, (_, i) => `R1,WK,T${i}`).join('\n');
    const files = miniSchedule({ 'trips.txt': trips });
    const store = await load(files, LIMIT);
    const needed = store.counts().estimatedBytes;
    expect(needed).toBeGreaterThan(100_000);
    const error = await failure(load(files, Math.floor(needed / 2)));
    expect(error.code).toBe('too_large');
    expect(error.message).not.toMatch(/https?:|\.zip/);
    // The limit applies to the peak (retained data plus per-trip scratch), above the final estimate.
    await expect(load(files, needed * 2)).resolves.toBeDefined();
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      parseSchedule(chunked(zipOf(miniSchedule())), new MemoryBudget(LIMIT), controller.signal),
    );
    expect(error.code).toBe('aborted');
  });
});
