import type { LatLng } from '@gtfs-rt-debugger/shared';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Initial compass bearing from `a` to `b`, degrees in [0, 360). */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const dLon = rad(b[1] - a[1]);
  const y = Math.sin(dLon) * Math.cos(rad(b[0]));
  const x =
    Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
    Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * `count` points spread evenly along the polyline through `waypoints`, with a small deterministic
 * sideways wobble so the line is not perfectly straight. Coordinates are rounded to six decimals,
 * the precision `shapes.txt` is written at.
 */
export function pointsAlong(waypoints: readonly LatLng[], count: number): LatLng[] {
  const legs = waypoints.slice(1).map((to, i) => distanceMeters(waypoints[i]!, to));
  const total = legs.reduce((sum, d) => sum + d, 0);
  const points: LatLng[] = [];
  for (let i = 0; i < count; i++) {
    let remaining = (total * i) / (count - 1);
    let leg = 0;
    while (leg < legs.length - 1 && remaining > legs[leg]!) remaining -= legs[leg++]!;
    const t = legs[leg]! === 0 ? 0 : Math.min(1, remaining / legs[leg]!);
    const from = waypoints[leg]!;
    const to = waypoints[leg + 1]!;
    const wobble = i === 0 || i === count - 1 ? 0 : 0.00018 * Math.sin(i * 1.7);
    points.push([
      round6(from[0] + (to[0] - from[0]) * t + wobble),
      round6(from[1] + (to[1] - from[1]) * t - wobble),
    ]);
  }
  return points;
}

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface Position {
  latitude: number;
  longitude: number;
  bearing: number;
}

/** A shape with cumulative distances, for placing a vehicle a given fraction of the way along it. */
export class ShapePath {
  readonly cumulative: number[] = [0];

  constructor(readonly points: readonly LatLng[]) {
    for (let i = 1; i < points.length; i++) {
      this.cumulative.push(this.cumulative[i - 1]! + distanceMeters(points[i - 1]!, points[i]!));
    }
  }

  get lengthMeters(): number {
    return this.cumulative[this.cumulative.length - 1]!;
  }

  at(fraction: number): Position {
    const target = Math.min(1, Math.max(0, fraction)) * this.lengthMeters;
    let i = 1;
    while (i < this.points.length - 1 && this.cumulative[i]! < target) i++;
    const a = this.points[i - 1]!;
    const b = this.points[i]!;
    const span = this.cumulative[i]! - this.cumulative[i - 1]!;
    const t = span === 0 ? 0 : (target - this.cumulative[i - 1]!) / span;
    return {
      latitude: a[0] + (b[0] - a[0]) * t,
      longitude: a[1] + (b[1] - a[1]) * t,
      bearing: bearingDegrees(a, b),
    };
  }
}
