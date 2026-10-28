import { afterEach, describe, expect, it } from 'vitest';
import { ageSeconds, formatAge, formatAgencyTime } from './time';

const utc = (iso: string) => Date.parse(iso) / 1000;

describe('formatAgencyTime', () => {
  it('renders 24-hour agency-local clock time', () => {
    expect(formatAgencyTime(utc('2026-07-01T18:05:09Z'), 'America/New_York')).toBe('14:05');
    expect(
      formatAgencyTime(utc('2026-07-01T18:05:09Z'), 'America/New_York', { seconds: true }),
    ).toBe('14:05:09');
  });

  it('renders midnight as 00:xx, never 24:xx', () => {
    expect(formatAgencyTime(utc('2026-07-01T04:00:00Z'), 'America/New_York')).toBe('00:00');
  });

  it('can include the date and the zone abbreviation', () => {
    expect(
      formatAgencyTime(utc('2026-07-01T18:05:09Z'), 'America/New_York', {
        date: true,
        zoneName: true,
      }),
    ).toBe('2026-07-01 14:05 EDT');
  });

  it('handles zones with half-hour and large offsets and date rollover', () => {
    const instant = utc('2026-07-01T20:00:00Z');
    expect(formatAgencyTime(instant, 'Asia/Kolkata', { date: true })).toBe('2026-07-02 01:30');
    expect(formatAgencyTime(instant, 'Pacific/Kiritimati', { date: true })).toBe(
      '2026-07-02 10:00',
    );
  });

  it('throws on an unknown zone instead of falling back to the browser zone', () => {
    expect(() => formatAgencyTime(0, 'Not/AZone')).toThrow(RangeError);
  });

  describe('across daylight-saving transitions (America/New_York)', () => {
    it('spring forward: 01:59:59 EST is followed by 03:00:00 EDT', () => {
      const opts = { seconds: true, zoneName: true } as const;
      expect(formatAgencyTime(utc('2026-03-08T06:59:59Z'), 'America/New_York', opts)).toBe(
        '01:59:59 EST',
      );
      expect(formatAgencyTime(utc('2026-03-08T07:00:00Z'), 'America/New_York', opts)).toBe(
        '03:00:00 EDT',
      );
    });

    it('fall back: 01:30 occurs twice, first as EDT then as EST', () => {
      const opts = { zoneName: true } as const;
      expect(formatAgencyTime(utc('2026-11-01T05:30:00Z'), 'America/New_York', opts)).toBe(
        '01:30 EDT',
      );
      expect(formatAgencyTime(utc('2026-11-01T06:30:00Z'), 'America/New_York', opts)).toBe(
        '01:30 EST',
      );
    });

    it('keeps the offset change out of the date: noon on each side of the change', () => {
      expect(formatAgencyTime(utc('2026-03-07T17:00:00Z'), 'America/New_York')).toBe('12:00');
      expect(formatAgencyTime(utc('2026-03-08T16:00:00Z'), 'America/New_York')).toBe('12:00');
    });
  });

  describe('independence from the process time zone', () => {
    const original = process.env.TZ;
    // Node re-reads TZ whenever process.env.TZ is assigned.
    afterEach(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    const instants = [
      utc('2026-03-08T06:59:59Z'),
      utc('2026-03-08T07:00:00Z'),
      utc('2026-07-01T18:05:09Z'),
      utc('2026-11-01T05:30:00Z'),
      utc('2026-11-01T06:30:00Z'),
    ];
    const render = () =>
      instants.map((t) =>
        formatAgencyTime(t, 'America/New_York', { date: true, seconds: true, zoneName: true }),
      );

    it('renders the same text whatever zone the process runs in', () => {
      const results: Record<string, string[]> = {};
      const hours: Record<string, number> = {};
      for (const tz of ['America/New_York', 'Pacific/Auckland', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = tz;
        // Prove the process zone really changed: the local hour of one instant differs.
        hours[tz] = new Date(utc('2026-07-01T18:05:09Z') * 1000).getHours();
        results[tz] = render();
      }
      expect(new Set(Object.values(hours)).size).toBeGreaterThan(1);
      expect(hours['America/New_York']).toBe(14);
      expect(hours['Asia/Tokyo']).toBe(3);
      const [first, ...rest] = Object.values(results);
      for (const other of rest) expect(other).toEqual(first);
      expect(first).toEqual([
        '2026-03-08 01:59:59 EST',
        '2026-03-08 03:00:00 EDT',
        '2026-07-01 14:05:09 EDT',
        '2026-11-01 01:30:00 EDT',
        '2026-11-01 01:30:00 EST',
      ]);
    });
  });
});

describe('age helpers', () => {
  it('computes whole seconds and never goes negative', () => {
    expect(ageSeconds(1012.9, 1000)).toBe(12);
    expect(ageSeconds(1000, 1005)).toBe(0);
  });

  it('formats ages compactly', () => {
    expect(formatAge(0)).toBe('0 s ago');
    expect(formatAge(12)).toBe('12 s ago');
    expect(formatAge(59)).toBe('59 s ago');
    expect(formatAge(60)).toBe('1 min ago');
    expect(formatAge(179)).toBe('2 min ago');
    expect(formatAge(3600)).toBe('1 h ago');
    expect(formatAge(3900)).toBe('1 h 5 min ago');
    expect(formatAge(-5)).toBe('0 s ago');
  });
});
