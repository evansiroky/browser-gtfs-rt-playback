import { describe, expect, it } from 'vitest';
import {
  addDays,
  agencyInstant,
  formatHms,
  parseHms,
  serviceDateOf,
  serviceDayStart,
  weekdayOf,
} from './time.js';

const LA = 'America/Los_Angeles';

describe('service dates', () => {
  it('changes at local midnight, not at UTC midnight', () => {
    expect(serviceDateOf(new Date('2026-10-14T06:59:59Z'), LA)).toBe('20261013');
    expect(serviceDateOf(new Date('2026-10-14T07:00:00Z'), LA)).toBe('20261014');
    expect(serviceDateOf(new Date('2026-12-15T07:59:59Z'), LA)).toBe('20261214');
    expect(serviceDateOf(new Date('2026-12-15T08:00:00Z'), LA)).toBe('20261215');
  });

  it('does calendar arithmetic across month and year ends', () => {
    expect(addDays('20261031', 1)).toBe('20261101');
    expect(addDays('20260101', -1)).toBe('20251231');
    expect(addDays('20240228', 1)).toBe('20240229');
    expect(weekdayOf('20261014')).toBe(3);
    expect(weekdayOf('20261011')).toBe(0);
  });
});

describe('service day start (noon minus 12 hours)', () => {
  it('is local midnight on an ordinary day', () => {
    expect(serviceDayStart('20261014', LA).toISOString()).toBe('2026-10-14T07:00:00.000Z');
    expect(serviceDayStart('20261214', LA).toISOString()).toBe('2026-12-14T08:00:00.000Z');
  });

  it('is an hour before local midnight on the spring-forward day, and an hour after on fall-back', () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00; noon is PDT (UTC-7), so noon - 12 h = 07:00Z = 23:00 PST.
    expect(serviceDayStart('20260308', LA).toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(serviceDayStart('20260307', LA).toISOString()).toBe('2026-03-07T08:00:00.000Z');
    // 2026-11-01: clocks fall back 02:00 -> 01:00; noon is PST (UTC-8), so noon - 12 h = 00:00 PST = 08:00Z.
    expect(serviceDayStart('20261101', LA).toISOString()).toBe('2026-11-01T08:00:00.000Z');
  });

  it('places GTFS times, including past 24:00:00, relative to it', () => {
    expect(agencyInstant('20261013', '25:30:00', LA).toISOString()).toBe(
      '2026-10-14T08:30:00.000Z',
    );
    expect(agencyInstant('20261014', '00:20:00', LA).toISOString()).toBe(
      '2026-10-14T07:20:00.000Z',
    );
  });
});

describe('HH:MM:SS', () => {
  it('round-trips, allowing hours past 24', () => {
    expect(formatHms(0)).toBe('00:00:00');
    expect(formatHms(91_800)).toBe('25:30:00');
    expect(parseHms('25:30:00')).toBe(91_800);
    expect(parseHms(formatHms(43_261))).toBe(43_261);
  });

  it('rejects what is not a time', () => {
    expect(() => parseHms('12:60:00')).toThrow(RangeError);
    expect(() => formatHms(-1)).toThrow(RangeError);
    expect(() => formatHms(1.5)).toThrow(RangeError);
  });
});
