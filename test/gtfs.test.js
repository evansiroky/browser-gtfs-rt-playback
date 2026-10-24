import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../src/vendor/fflate.js';
import { summarizeGtfs, GtfsError } from '../src/gtfs.js';

const base = {
  'agency.txt': 'agency_id,agency_name,agency_url,agency_timezone\n1,Test Transit,https://t.example,America/Chicago\n',
  'routes.txt': 'route_id,route_short_name\nR1,1\nR2,2\nR3,3\n',
  'stops.txt': 'stop_id,stop_name,location_type\nS1,"Main, 1st",0\nS2,Station,1\n',
};
const zip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

test('summarizes agency, counts, and date range from calendar + calendar_dates', () => {
  const summary = summarizeGtfs(
    zip({
      ...base,
      'calendar.txt': 'service_id,start_date,end_date\nWK,20260105,20260630\nSA,20260110,20260620\n',
      'calendar_dates.txt':
        'service_id,date,exception_type\nWK,20260101,1\nWK,20260704,2\nSA,20261231,1\n',
    }),
  );
  assert.deepEqual(summary, {
    agencies: [{ name: 'Test Transit', url: 'https://t.example', timezone: 'America/Chicago' }],
    routeCount: 3,
    stopCount: 2,
    serviceStart: '2026-01-01',
    serviceEnd: '2026-12-31',
  });
});

test('works with calendar_dates.txt alone; removed-service dates are ignored', () => {
  const summary = summarizeGtfs(
    zip({ ...base, 'calendar_dates.txt': 'service_id,date,exception_type\nA,20260301,1\nA,20260201,2\nA,20260305,1\n' }),
  );
  assert.equal(summary.serviceStart, '2026-03-01');
  assert.equal(summary.serviceEnd, '2026-03-05');
});

test('range is unknown when no dates are defined', () => {
  const summary = summarizeGtfs(zip(base));
  assert.equal(summary.serviceStart, null);
  assert.equal(summary.serviceEnd, null);
});

test('missing required file is an error naming the file', () => {
  const { 'stops.txt': _, ...rest } = base;
  assert.throws(() => summarizeGtfs(zip(rest)), (e) => e instanceof GtfsError && /stops\.txt/.test(e.message));
});

test('non-zip input is an error', () => {
  assert.throws(() => summarizeGtfs(strToU8('<html>nope</html>')), (e) => e instanceof GtfsError && /zip/.test(e.message));
});
