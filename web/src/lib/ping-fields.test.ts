import { describe, expect, it } from 'vitest';
import { NOW, ping } from '@/test/fixtures';
import { hasCoordinates, pingFields, pingTime, vehicleText } from './ping-fields';

describe('pingFields', () => {
  it('omits absent fields rather than showing them empty', () => {
    expect(pingFields(ping(1)).map((field) => field.key)).toEqual(['latitude', 'longitude']);
  });

  it('shows every present field with its unit, in a fixed order, then unknown ones by name', () => {
    const fields = pingFields({
      ...ping(1, { speed: 3, bearing: 10, odometer: 500, occupancyPercentage: 40, stopId: 'S1' }),
      tripProperties: { tripId: 'x' },
      zero: 0,
      empty: null,
    } as Parameters<typeof pingFields>[0]);
    expect(fields.map((f) => `${f.key}=${f.value}`)).toEqual([
      'latitude=37.781',
      'longitude=-122.41',
      'bearing=10°',
      'speed=3 m/s',
      'odometer=500 m',
      'stopId=S1',
      'occupancyPercentage=40%',
      'tripProperties={"tripId":"x"}',
      'zero=0',
    ]);
  });

  it('shows a zero value, which is a value', () => {
    expect(pingFields(ping(1, { bearing: 0, directionId: 0 })).map((f) => f.key)).toEqual([
      'latitude',
      'longitude',
      'bearing',
      'directionId',
    ]);
  });
});

describe('vehicleText, pingTime, hasCoordinates', () => {
  it('adds the label to the vehicle ID when there is one', () => {
    expect(vehicleText({ vehicleId: 'b1', vehicleLabel: null })).toBe('b1');
    expect(vehicleText({ vehicleId: 'b1', vehicleLabel: 'Bus One' })).toBe('b1 (Bus One)');
  });

  it('formats the vehicle timestamp on the agency clock with seconds', () => {
    expect(pingTime({ timestamp: NOW }, 'America/Los_Angeles')).toBe('00:00:00');
    expect(pingTime({ timestamp: NOW + 61 }, 'America/New_York')).toBe('03:01:01');
    expect(pingTime({ timestamp: NOW }, null)).toBeNull();
    expect(pingTime({ timestamp: NOW }, 'Not/AZone')).toBeNull();
  });

  it('needs both coordinates', () => {
    expect(hasCoordinates({ latitude: 0, longitude: 0 })).toBe(true);
    expect(hasCoordinates({ latitude: 1, longitude: null })).toBe(false);
    expect(hasCoordinates({ latitude: null, longitude: null })).toBe(false);
  });
});
