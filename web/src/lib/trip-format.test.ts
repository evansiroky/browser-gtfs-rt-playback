import { TRIP_REASONS } from '@gtfs-rt-debugger/shared';
import { describe, expect, it } from 'vitest';
import { NOW, tripItem } from '@/test/fixtures';
import {
  REASON_TEXT,
  agencyTime,
  classificationLabel,
  formatServiceDate,
  formatHeadway,
  formatSpan,
  matchesSearch,
  rowKeys,
  routeLabel,
  tripPath,
} from './trip-format';

describe('REASON_TEXT', () => {
  it('uses the exact texts of the screen spec', () => {
    expect(REASON_TEXT).toEqual({
      unknown_trip: 'Trip ID not in schedule',
      not_in_service: 'Not in service on this date',
      configuration_error: 'Schedule configuration error (see trip)',
      missing_start_time: 'Frequency trip, but the feed sent no start time',
      unmatched_start_time: 'Start time matches no scheduled departure',
      outside_scheduled_time: 'Outside its scheduled time',
    });
  });

  it('covers every reason the API can send', () => {
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...TRIP_REASONS].sort());
  });
});

describe('routeLabel', () => {
  it('prefers the short name, then the long name, then the route ID', () => {
    const base = { routeShortName: '38', routeLongName: 'Geary', routeId: 'r1' };
    expect(routeLabel(base)).toBe('38');
    expect(routeLabel({ ...base, routeShortName: null })).toBe('Geary');
    expect(routeLabel({ ...base, routeShortName: '', routeLongName: '' })).toBe('r1');
    expect(routeLabel({ routeShortName: null, routeLongName: null, routeId: null })).toBeNull();
  });
});

describe('formatHeadway', () => {
  it('says whole minutes as "N min" and keeps the rest', () => {
    expect(formatHeadway(600)).toBe('10 min');
    expect(formatHeadway(90)).toBe('1 min 30 s');
    expect(formatHeadway(45)).toBe('45 s');
  });
});

describe('formatSpan', () => {
  it('renders start–end on the agency clock', () => {
    const item = tripItem({ scheduledStart: NOW, scheduledEnd: NOW + 3000 });
    expect(formatSpan(item, 'America/Los_Angeles')).toBe('00:00–00:50');
    expect(formatSpan(item, 'America/New_York')).toBe('03:00–03:50');
  });

  it('shows no clock time without a timezone or a span', () => {
    expect(formatSpan(tripItem(), null)).toBeNull();
    expect(formatSpan(tripItem({ scheduledStart: null, scheduledEnd: null }), 'UTC')).toBeNull();
  });
});

describe('matchesSearch', () => {
  const item = tripItem({
    tripId: 'Trip-ABC',
    routeId: 'R9',
    routeShortName: '38',
    routeLongName: 'Geary',
  });

  it('matches trip ID and route fields, ignoring case and surrounding blanks', () => {
    for (const query of ['abc', ' TRIP-a ', 'r9', '38', 'gea', '']) {
      expect(matchesSearch(item, query), query).toBe(true);
    }
  });

  it('does not match the headsign or other text', () => {
    expect(matchesSearch(item, 'downtown')).toBe(false);
    expect(matchesSearch(item, 'zzz')).toBe(false);
  });
});

describe('rowKeys', () => {
  it('gives rows that share a trip ID distinct keys', () => {
    const a = tripItem({ tripId: 'f', scheduledStart: 100 });
    const b = tripItem({ tripId: 'f', scheduledStart: 700 });
    const keys = rowKeys([a, b]);
    expect(new Set(keys).size).toBe(2);
  });

  it('stays unique, and stable, for rows that are otherwise identical', () => {
    const rows = [tripItem(), tripItem(), tripItem()];
    const keys = rowKeys(rows);
    expect(new Set(keys).size).toBe(3);
    expect(rowKeys(rows)).toEqual(keys);
  });
});

describe('tripPath', () => {
  it('percent-encodes the trip ID and carries no query', () => {
    expect(tripPath('a b/c?d')).toBe('/trips/a%20b%2Fc%3Fd');
  });
});

describe('formatServiceDate', () => {
  it('inserts dashes into YYYYMMDD and leaves anything else alone', () => {
    expect(formatServiceDate('20270115')).toBe('2027-01-15');
    expect(formatServiceDate('soon')).toBe('soon');
  });
});

describe('agencyTime', () => {
  it('is null until the timezone is known or when it is unusable', () => {
    expect(agencyTime(NOW, null)).toBeNull();
    expect(agencyTime(NOW, 'Not/AZone')).toBeNull();
    expect(agencyTime(NOW, 'America/Los_Angeles', { seconds: true })).toBe('00:00:00');
  });
});

describe('classificationLabel', () => {
  const zone = 'America/Los_Angeles';
  it('names the list and, for the unscheduled one, the reason', () => {
    expect(
      classificationLabel(
        { list: 'unscheduled-with-realtime', reason: 'unknown_trip', start: null, end: null },
        zone,
      ),
    ).toEqual({
      text: 'Not scheduled this minute, with realtime data',
      detail: 'Trip ID not in schedule',
    });
  });

  it('adds the entry span on the agency clock, which tells frequency instances apart', () => {
    expect(
      classificationLabel(
        { list: 'active-without-realtime', reason: null, start: NOW, end: NOW + 1800 },
        zone,
      ),
    ).toEqual({ text: 'Active now, without realtime data', detail: '00:00–00:30' });
    expect(
      classificationLabel(
        { list: 'active-with-realtime', reason: null, start: NOW, end: NOW + 1800 },
        null,
      ),
    ).toEqual({ text: 'Active now, with realtime data', detail: null });
  });
});
