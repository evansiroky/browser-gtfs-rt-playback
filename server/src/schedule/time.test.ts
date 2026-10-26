import { describe, expect, it } from 'vitest';
import { parseGtfsTime } from './time.js';

describe('parseGtfsTime', () => {
  it.each([
    ['00:00:00', 0],
    ['08:30:15', 30_615],
    ['8:30:15', 30_615],
    ['24:00:00', 86_400],
    ['25:30:00', 91_800],
    ['48:00:01', 172_801],
    [' 08:30:15 ', 30_615],
    ['08:59:59', 32_399],
  ])('reads %s', (text, seconds) => {
    expect(parseGtfsTime(text)).toBe(seconds);
  });

  it.each([
    '',
    '   ',
    'soon',
    '08:60:00',
    '08:00:60',
    '08:99:00',
    '8:5:00',
    '08:30',
    '08:30:15:00',
    '-08:30:15',
    '1e1:00:00',
    '0x8:00:00',
    '1000:00:00',
  ])('treats %j as missing', (text) => {
    expect(parseGtfsTime(text)).toBeNull();
  });

  it('treats an absent value as missing', () => {
    expect(parseGtfsTime(undefined)).toBeNull();
  });
});
