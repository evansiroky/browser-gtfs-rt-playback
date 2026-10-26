import { describe, expect, it } from 'vitest';
import { ServiceCalendar } from './calendar.js';

function weekly(
  serviceId: string,
  days: string,
  startDate: string,
  endDate: string,
): Record<string, string> {
  const [monday, tuesday, wednesday, thursday, friday, saturday, sunday] = days.split('');
  return {
    service_id: serviceId,
    monday: monday!,
    tuesday: tuesday!,
    wednesday: wednesday!,
    thursday: thursday!,
    friday: friday!,
    saturday: saturday!,
    sunday: sunday!,
    start_date: startDate,
    end_date: endDate,
  };
}

const exception = (serviceId: string, date: string, type: string) => ({
  service_id: serviceId,
  date,
  exception_type: type,
});

// 2026-10-12 is a Monday.
const MON = '20261012';
const TUE = '20261013';
const SAT = '20261017';
const SUN = '20261018';

describe('ServiceCalendar', () => {
  it('runs a service on the weekdays whose flag is 1', () => {
    const calendar = new ServiceCalendar();
    calendar.addWeekly(weekly('WK', '1111100', '20260101', '20261231'));
    calendar.addWeekly(weekly('SUN', '0000001', '20260101', '20261231'));
    expect(calendar.operatesOn('WK', MON)).toBe(true);
    expect(calendar.operatesOn('WK', SAT)).toBe(false);
    expect(calendar.operatesOn('WK', SUN)).toBe(false);
    expect(calendar.operatesOn('SUN', SUN)).toBe(true);
    expect(calendar.operatesOn('SUN', MON)).toBe(false);
  });

  it('includes both ends of the date range and nothing outside it', () => {
    const calendar = new ServiceCalendar();
    calendar.addWeekly(weekly('S', '1111111', '20261013', '20261017'));
    expect(calendar.operatesOn('S', '20261012')).toBe(false);
    expect(calendar.operatesOn('S', '20261013')).toBe(true);
    expect(calendar.operatesOn('S', '20261017')).toBe(true);
    expect(calendar.operatesOn('S', '20261018')).toBe(false);
  });

  it('lets a type 2 exception remove a date and a type 1 exception add one', () => {
    const calendar = new ServiceCalendar();
    calendar.addWeekly(weekly('WK', '1111100', '20260101', '20261231'));
    calendar.addException(exception('WK', TUE, '2'));
    calendar.addException(exception('WK', SAT, '1'));
    expect(calendar.operatesOn('WK', TUE)).toBe(false);
    expect(calendar.operatesOn('WK', MON)).toBe(true);
    expect(calendar.operatesOn('WK', SAT)).toBe(true);
    expect(calendar.operatesOn('WK', SUN)).toBe(false);
  });

  it('applies an added date even outside the date range', () => {
    const calendar = new ServiceCalendar();
    calendar.addWeekly(weekly('S', '1111111', '20261013', '20261014'));
    calendar.addException(exception('S', '20270101', '1'));
    expect(calendar.operatesOn('S', '20270101')).toBe(true);
  });

  it('runs a service only in calendar_dates.txt exactly on its type 1 dates', () => {
    const calendar = new ServiceCalendar();
    calendar.addException(exception('EXTRA', TUE, '1'));
    calendar.addException(exception('EXTRA', SAT, '2'));
    expect(calendar.operatesOn('EXTRA', TUE)).toBe(true);
    expect(calendar.operatesOn('EXTRA', MON)).toBe(false);
    expect(calendar.operatesOn('EXTRA', SAT)).toBe(false);
  });

  it('does not run an unknown service, and ignores unknown exception types', () => {
    const calendar = new ServiceCalendar();
    calendar.addException(exception('X', TUE, '3'));
    expect(calendar.operatesOn('X', TUE)).toBe(false);
    expect(calendar.operatesOn('nope', TUE)).toBe(false);
  });

  it('counts a date that is both added and removed as added', () => {
    const calendar = new ServiceCalendar();
    calendar.addException(exception('B', TUE, '2'));
    calendar.addException(exception('B', TUE, '1'));
    expect(calendar.operatesOn('B', TUE)).toBe(true);
  });

  it('ignores rows whose dates are not YYYYMMDD, and answers false for a malformed date', () => {
    const calendar = new ServiceCalendar();
    expect(calendar.addWeekly(weekly('BAD', '1111111', '2026-01-01', '20261231'))).toBeNull();
    expect(calendar.addWeekly(weekly('GOOD', '1111111', '20260101', '20261231'))).toBe('GOOD');
    expect(calendar.addWeekly(weekly('GOOD', '0000000', '20260101', '20261231'))).toBeNull();
    expect(calendar.addException(exception('BAD', 'tomorrow', '1'))).toEqual({
      newServiceId: null,
      kept: false,
    });
    expect(calendar.addException(exception('GOOD', '20261014', '1'))).toEqual({
      newServiceId: 'GOOD',
      kept: true,
    });
    expect(calendar.addException(exception('GOOD', '20261015', '2'))).toEqual({
      newServiceId: null,
      kept: true,
    });
    expect(calendar.operatesOn('BAD', MON)).toBe(false);
    expect(calendar.operatesOn('GOOD', MON)).toBe(true);
    expect(calendar.operatesOn('GOOD', '2026-10-12')).toBe(false);
    expect(calendar.operatesOn('GOOD', '')).toBe(false);
  });
});
