/**
 * Google encoded polyline algorithm at precision 6 (six decimal places, about 0.1 m), the
 * wire format of shapes ([data-model](../../specs/data-model.md#shape)).
 *
 * Arithmetic instead of bit operations keeps values beyond 32 bits exact.
 */

/** A point as `[latitude, longitude]` in degrees. */
export type LatLng = readonly [latitude: number, longitude: number];

const PRECISION = 1e6;
const CHUNK_RADIX = 32;
const CONTINUATION = 0x20;
const ASCII_OFFSET = 63;
// 10 chunks carry 50 bits, enough for any coordinate difference a real shape can have while
// keeping every decoded integer exactly representable.
const MAX_CHUNKS_PER_VALUE = 10;

function encodeValue(value: number, out: string[]): void {
  // Zigzag: the sign goes in the lowest bit.
  let rest = value < 0 ? -2 * value - 1 : 2 * value;
  while (rest >= CHUNK_RADIX) {
    out.push(String.fromCharCode((rest % CHUNK_RADIX) + CONTINUATION + ASCII_OFFSET));
    rest = Math.floor(rest / CHUNK_RADIX);
  }
  out.push(String.fromCharCode(rest + ASCII_OFFSET));
}

/** Encodes points in order. Throws `RangeError` for a non-finite coordinate. */
export function encodePolyline6(points: readonly LatLng[]): string {
  const out: string[] = [];
  let prevLat = 0;
  let prevLon = 0;
  for (const [latitude, longitude] of points) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new RangeError(`Cannot encode non-finite coordinate (${latitude}, ${longitude})`);
    }
    const lat = Math.round(latitude * PRECISION);
    const lon = Math.round(longitude * PRECISION);
    encodeValue(lat - prevLat, out);
    encodeValue(lon - prevLon, out);
    prevLat = lat;
    prevLon = lon;
  }
  return out.join('');
}

/** Decodes a precision-6 polyline. Throws `Error` for a malformed, truncated or oversized-value string. */
export function decodePolyline6(encoded: string): [latitude: number, longitude: number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  const readValue = (): number => {
    let result = 0;
    let scale = 1;
    let chunk: number;
    let chunks = 0;
    do {
      if (++chunks > MAX_CHUNKS_PER_VALUE) {
        throw new Error('Malformed polyline: value too long');
      }
      if (index >= encoded.length) {
        throw new Error('Malformed polyline: truncated value');
      }
      chunk = encoded.charCodeAt(index++) - ASCII_OFFSET;
      if (chunk < 0 || chunk >= 2 * CHUNK_RADIX) {
        throw new Error(`Malformed polyline: invalid character at index ${index - 1}`);
      }
      result += (chunk % CHUNK_RADIX) * scale;
      scale *= CHUNK_RADIX;
    } while (chunk >= CONTINUATION);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };

  while (index < encoded.length) {
    lat += readValue();
    lon += readValue();
    const point: [number, number] = [lat / PRECISION, lon / PRECISION];
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      throw new Error('Malformed polyline: non-finite coordinate');
    }
    points.push(point);
  }
  return points;
}
