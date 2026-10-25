import { describe, expect, it } from 'vitest';
import { decodePolyline6, encodePolyline6, type LatLng } from './polyline.js';

/** Independent reference (the textbook bit-twiddling form), valid for 32-bit deltas. */
function referenceEncode(points: readonly LatLng[], precision: number): string {
  const factor = 10 ** precision;
  const encodeSigned = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  let prevLat = 0;
  let prevLon = 0;
  let out = '';
  for (const [lat, lon] of points) {
    const a = Math.round(lat * factor);
    const b = Math.round(lon * factor);
    out += encodeSigned(a - prevLat) + encodeSigned(b - prevLon);
    prevLat = a;
    prevLon = b;
  }
  return out;
}

/** Deterministic PRNG so the property tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GOOGLE_POINTS: LatLng[] = [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453],
];
// Google's documented precision-5 string for GOOGLE_POINTS.
const GOOGLE_PRECISION_5 = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
// The same points at precision 6, derived with an independent implementation.
const GOOGLE_PRECISION_6 = '_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI';

describe('known vectors', () => {
  it('reference implementation reproduces the canonical Google example', () => {
    expect(referenceEncode(GOOGLE_POINTS, 5)).toBe(GOOGLE_PRECISION_5);
    expect(referenceEncode(GOOGLE_POINTS, 6)).toBe(GOOGLE_PRECISION_6);
  });

  it('encodes the Google example at precision 6', () => {
    expect(encodePolyline6(GOOGLE_POINTS)).toBe(GOOGLE_PRECISION_6);
  });

  it('decodes the Google example at precision 6', () => {
    expect(decodePolyline6(GOOGLE_PRECISION_6)).toEqual(GOOGLE_POINTS);
  });

  it('encodes the origin and the smallest steps', () => {
    expect(encodePolyline6([[0, 0]])).toBe('??');
    expect(encodePolyline6([[-0.000001, 0.000001]])).toBe('@A');
    expect(decodePolyline6('@A')).toEqual([[-0.000001, 0.000001]]);
  });

  it('encodes the world corners', () => {
    const corners: LatLng[] = [
      [90, 180],
      [-90, -180],
    ];
    expect(encodePolyline6(corners)).toBe('_gdtjD_oiivI~niivI~~ssmT');
    expect(decodePolyline6('_gdtjD_oiivI~niivI~~ssmT')).toEqual(corners);
  });

  it('encodes a realistic city-scale pair', () => {
    const pts: LatLng[] = [
      [47.6062, -122.3321],
      [47.6097, -122.3331],
    ];
    expect(encodePolyline6(pts)).toBe('ozsxyAf{pihFwyEn}@');
    expect(decodePolyline6('ozsxyAf{pihFwyEn}@')).toEqual(pts);
  });
});

describe('edge cases', () => {
  it('handles empty input', () => {
    expect(encodePolyline6([])).toBe('');
    expect(decodePolyline6('')).toEqual([]);
  });

  it('handles a single point', () => {
    const encoded = encodePolyline6([[51.5074, -0.1278]]);
    expect(encoded).toBe(referenceEncode([[51.5074, -0.1278]], 6));
    expect(decodePolyline6(encoded)).toEqual([[51.5074, -0.1278]]);
  });

  it('handles negative coordinates in every quadrant', () => {
    const pts: LatLng[] = [
      [-33.8688, 151.2093],
      [-34.6037, -58.3816],
      [35.6762, -139.6503],
      [-0.000123, -0.000456],
    ];
    expect(encodePolyline6(pts)).toBe(referenceEncode(pts, 6));
    expect(decodePolyline6(encodePolyline6(pts))).toEqual(pts);
  });

  it('keeps repeated points as zero deltas', () => {
    const pts: LatLng[] = [
      [10, 20],
      [10, 20],
      [10, 20],
    ];
    expect(encodePolyline6(pts)).toBe(referenceEncode(pts, 6));
    expect(decodePolyline6(encodePolyline6(pts))).toEqual(pts);
  });

  it('handles the full latitude/longitude range', () => {
    const pts: LatLng[] = [
      [-90, -180],
      [90, 180],
      [-90, 180],
      [90, -180],
    ];
    expect(encodePolyline6(pts)).toBe(referenceEncode(pts, 6));
    expect(decodePolyline6(encodePolyline6(pts))).toEqual(pts);
  });

  it('stays exact for values far beyond 32-bit scaled integers', () => {
    const pts: LatLng[] = [
      [1234567.891234, -7654321.123456],
      [-9999999.999999, 9999999.999999],
    ];
    expect(decodePolyline6(encodePolyline6(pts))).toEqual(pts);
  });

  it('rejects non-finite coordinates', () => {
    expect(() => encodePolyline6([[Number.NaN, 0]])).toThrow(RangeError);
    expect(() => encodePolyline6([[0, Number.POSITIVE_INFINITY]])).toThrow(RangeError);
  });

  it('rejects truncated and invalid input', () => {
    expect(() => decodePolyline6('_p~iF')).toThrow(/truncated/);
    expect(() => decodePolyline6('_')).toThrow(/truncated/);
    expect(() => decodePolyline6('ab cd')).toThrow(/invalid character/);
    expect(() => decodePolyline6('ÿ?')).toThrow(/invalid character/);
  });

  it('rejects values with runaway continuation chunks', () => {
    expect(() => decodePolyline6('_'.repeat(205) + '??')).toThrow(/value too long/);
    expect(() => decodePolyline6('~'.repeat(20) + '??')).toThrow(/value too long/);
    expect(() => decodePolyline6('_'.repeat(10) + '?')).toThrow(/value too long/);
  });

  it('still accepts the longest legitimate values', () => {
    // 1e7 degrees from the origin needs 10 chunks per component.
    const far: LatLng[] = [[9999999.999999, -9999999.999999]];
    expect(decodePolyline6(encodePolyline6(far))).toEqual(far);
  });
});

describe('rounding at the 6th decimal', () => {
  it('rounds to the nearest millionth of a degree', () => {
    expect(decodePolyline6(encodePolyline6([[1.2345674, -1.2345674]]))).toEqual([
      [1.234567, -1.234567],
    ]);
    expect(decodePolyline6(encodePolyline6([[1.2345676, -1.2345676]]))).toEqual([
      [1.234568, -1.234568],
    ]);
  });

  it('encodes sub-resolution noise identically to the rounded point', () => {
    expect(encodePolyline6([[1.2345674, 2.0000004]])).toBe(encodePolyline6([[1.234567, 2]]));
    expect(encodePolyline6([[1.2345676, 2.9999996]])).toBe(encodePolyline6([[1.234568, 3]]));
  });

  it('computes deltas on rounded integers so error never accumulates', () => {
    const pts: LatLng[] = Array.from({ length: 2000 }, (_, i) => [
      40 + i * 0.0000004,
      -75 - i * 0.0000004,
    ]);
    const decoded = decodePolyline6(encodePolyline6(pts));
    pts.forEach(([lat, lon], i) => {
      const [dLat, dLon] = decoded[i]!;
      expect(Math.abs(dLat - lat)).toBeLessThanOrEqual(0.0000005 + 1e-9);
      expect(Math.abs(dLon - lon)).toBeLessThanOrEqual(0.0000005 + 1e-9);
    });
  });
});

describe('round-trip properties', () => {
  it('stays within half a millionth of a degree for random polylines', () => {
    const random = mulberry32(0x6717);
    for (let run = 0; run < 200; run++) {
      const length = Math.floor(random() * 60);
      const pts: LatLng[] = Array.from({ length }, () => [
        random() * 180 - 90,
        random() * 360 - 180,
      ]);
      const decoded = decodePolyline6(encodePolyline6(pts));
      expect(decoded).toHaveLength(pts.length);
      pts.forEach(([lat, lon], i) => {
        const [dLat, dLon] = decoded[i]!;
        expect(Math.abs(dLat - lat)).toBeLessThanOrEqual(0.0000005 + 1e-9);
        expect(Math.abs(dLon - lon)).toBeLessThanOrEqual(0.0000005 + 1e-9);
      });
    }
  });

  it('is idempotent once rounded: decode(encode(decode(encode(p)))) is stable', () => {
    const random = mulberry32(42);
    const pts: LatLng[] = Array.from({ length: 500 }, () => [
      random() * 180 - 90,
      random() * 360 - 180,
    ]);
    const once = encodePolyline6(pts);
    const twice = encodePolyline6(decodePolyline6(once));
    expect(twice).toBe(once);
  });

  it('matches the reference encoder on random input', () => {
    const random = mulberry32(7);
    for (let run = 0; run < 100; run++) {
      const pts: LatLng[] = Array.from({ length: 1 + Math.floor(random() * 40) }, () => [
        random() * 180 - 90,
        random() * 360 - 180,
      ]);
      expect(encodePolyline6(pts)).toBe(referenceEncode(pts, 6));
    }
  });
});
