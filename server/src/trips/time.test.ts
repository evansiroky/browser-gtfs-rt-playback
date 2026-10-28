import {
  addDays as fixtureAddDays,
  serviceDayStart as fixtureStart,
} from '@gtfs-rt-debugger/fixtures';
import { describe, expect, it } from 'vitest';
import { addDays, agencyDate, isServiceDate, serviceDayStart } from './time.js';
import { AGENCY_DATES, SERVICE_DAY_STARTS } from './zone-table.js';

const seconds = (iso: string): number => Date.parse(iso) / 1000;

describe('serviceDayStart: local noon minus 12 hours of elapsed time', () => {
  it.each([
    // a day without a change starts at local midnight
    ['America/Los_Angeles', '20261014', '2026-10-14T07:00:00Z'],
    ['America/Los_Angeles', '20260115', '2026-01-15T08:00:00Z'],
    // spring forward (2026-03-08, 02:00 PST -> 03:00 PDT): a 23-hour day, noon is PDT, so the
    // day starts at 23:00 PST the evening before
    ['America/Los_Angeles', '20260308', '2026-03-08T07:00:00Z'],
    ['America/Los_Angeles', '20260309', '2026-03-09T07:00:00Z'],
    // fall back (2026-11-01, 02:00 PDT -> 01:00 PST): a 25-hour day, noon is PST, so the day
    // starts at 01:00 PDT
    ['America/Los_Angeles', '20261101', '2026-11-01T08:00:00Z'],
    ['America/Los_Angeles', '20261102', '2026-11-02T08:00:00Z'],
    ['Europe/London', '20260329', '2026-03-28T23:00:00Z'],
    ['Europe/London', '20261025', '2026-10-25T00:00:00Z'],
    ['Asia/Kolkata', '20261014', '2026-10-13T18:30:00Z'],
    // Lord Howe: a half-hour change (2026-10-04, 02:00 +10:30 -> 02:30 +11:00); noon is +11
    // Auckland: 2026-09-27, 02:00 +12 -> 03:00 +13; noon is +13
    ['Australia/Lord_Howe', '20261004', '2026-10-03T13:00:00Z'],
    ['Pacific/Auckland', '20260927', '2026-09-26T11:00:00Z'],
  ])('%s %s starts at %s', (zone, date, iso) => {
    expect(serviceDayStart(date, zone!)).toBe(seconds(iso));
  });

  it('agrees with the IANA database (Python zoneinfo) around every change of offset in 2026, in 15 zones', () => {
    expect(SERVICE_DAY_STARTS.length).toBeGreaterThan(100);
    for (const [zone, date, expected] of SERVICE_DAY_STARTS) {
      expect(serviceDayStart(date, zone), `${zone} ${date}`).toBe(expected);
    }
  });

  it('also agrees with the fixtures package on every day of 2026 in six zones', () => {
    let date = '20260101';
    for (let day = 0; day < 365; day++, date = addDays(date, 1)) {
      for (const zone of [
        'America/Los_Angeles',
        'America/New_York',
        'Europe/London',
        'Asia/Kolkata',
        'Australia/Lord_Howe',
        'Pacific/Auckland',
      ]) {
        expect(serviceDayStart(date, zone), `${date} ${zone}`).toBe(
          fixtureStart(date, zone).getTime() / 1000,
        );
      }
    }
  });
});

describe('agencyDate', () => {
  it.each([
    ['2026-10-14T06:59:59Z', '20261013'],
    ['2026-10-14T07:00:00Z', '20261014'],
    ['2026-10-15T06:59:59Z', '20261014'],
    // spring forward: 23 hours after 2026-03-08 00:00 PST the date turns
    ['2026-03-08T07:59:59Z', '20260307'],
    ['2026-03-08T08:00:00Z', '20260308'],
    ['2026-03-09T06:59:59Z', '20260308'],
    ['2026-03-09T07:00:00Z', '20260309'],
    // fall back: 01:15 happens twice, both on the 1st; the 2nd starts at 00:00 PST
    ['2026-11-01T06:59:59Z', '20261031'],
    ['2026-11-01T07:00:00Z', '20261101'],
    ['2026-11-01T08:15:00Z', '20261101'],
    ['2026-11-01T09:15:00Z', '20261101'],
    ['2026-11-02T07:59:59Z', '20261101'],
    ['2026-11-02T08:00:00Z', '20261102'],
  ])('%s in Los Angeles is %s', (iso, date) => {
    expect(agencyDate(Date.parse(iso), 'America/Los_Angeles')).toBe(date);
  });

  it('agrees with the IANA database (Python zoneinfo) at and around every change of offset in 2026', () => {
    expect(AGENCY_DATES.length).toBeGreaterThan(80);
    for (const [zone, instant, date] of AGENCY_DATES) {
      expect(agencyDate(instant * 1000, zone), `${zone} ${instant}`).toBe(date);
    }
  });

  it('is east of UTC in Auckland', () => {
    expect(agencyDate(Date.parse('2026-10-14T10:59:59Z'), 'Pacific/Auckland')).toBe('20261014');
    expect(agencyDate(Date.parse('2026-10-14T11:00:00Z'), 'Pacific/Auckland')).toBe('20261015');
  });
});

describe('service date arithmetic', () => {
  it.each([
    ['20261014', -1, '20261013'],
    ['20261001', -1, '20260930'],
    ['20260101', -1, '20251231'],
    ['20240301', -1, '20240229'],
    ['20251231', 1, '20260101'],
    ['20261014', 0, '20261014'],
    ['20261014', 30, '20261113'],
  ])('%s %i days is %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
    expect(fixtureAddDays(date, days)).toBe(expected);
  });

  it('knows a real calendar date from text that merely looks like one', () => {
    for (const ok of ['20261014', '20240229', '19990101', '20261231'])
      expect(isServiceDate(ok)).toBe(true);
    for (const bad of [
      '20230229',
      '20261301',
      '20260001',
      '20260132',
      '2026-10-14',
      '2026101',
      '202610140',
      'abcdefgh',
      '',
      null,
      undefined,
    ]) {
      expect(isServiceDate(bad), String(bad)).toBe(false);
    }
  });
});
