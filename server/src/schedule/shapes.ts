import { encodePolyline6, type LatLng } from '@gtfs-rt-debugger/shared';
import type { MemoryBudget } from './memory.js';
import { stringBytes } from './memory.js';
import type { Row } from './store.js';

/** Estimate of one buffered raw point: three numbers in growable arrays. */
const POINT_BYTES = 32;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseNumber(text: string | undefined): number | null {
  const trimmed = text?.trim();
  return trimmed !== undefined && NUMBER.test(trimmed) ? Number(trimmed) : null;
}

/** The raw points of one shape, held only until the shape is encoded. */
class ShapePoints {
  readonly lat: number[] = [];
  readonly lon: number[] = [];
  readonly seq: number[] = [];
  #ordered = true;

  get length(): number {
    return this.seq.length;
  }

  add(lat: number, lon: number, seq: number): void {
    if (this.#ordered && this.seq.length > 0 && seq < this.seq[this.seq.length - 1]!) {
      this.#ordered = false;
    }
    this.lat.push(lat);
    this.lon.push(lon);
    this.seq.push(seq);
  }

  /** The precision-6 polyline of the points ordered by sequence (ties keep file order). */
  encode(): string {
    const order = this.seq.map((_, i) => i);
    if (!this.#ordered) order.sort((a, b) => this.seq[a]! - this.seq[b]!);
    return encodePolyline6(order.map((i): LatLng => [this.lat[i]!, this.lon[i]!]));
  }
}

/** The point of a `shapes.txt` row, or null when its latitude, longitude or sequence is unusable. */
function readPoint(row: Row): { lat: number; lon: number; seq: number } | null {
  const lat = parseNumber(row['shape_pt_lat']);
  const lon = parseNumber(row['shape_pt_lon']);
  const seq = parseNumber(row['shape_pt_sequence']);
  if (lat === null || lon === null || seq === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, seq };
}

class NotGrouped extends Error {}

/** One shape's polyline, charged to the budget; a shape without any valid point has none. */
function finish(
  id: string,
  points: ShapePoints,
  shapes: Map<string, string>,
  budget: MemoryBudget,
): void {
  const polyline = points.length > 0 ? points.encode() : null;
  budget.release(points.length * POINT_BYTES);
  if (polyline === null) return;
  budget.add(stringBytes(id) + stringBytes(polyline) + 32);
  shapes.set(id, polyline);
}

/** Single pass for a file grouped by `shape_id`: one shape's raw points at a time. */
async function encodeGrouped(
  rows: AsyncIterable<Row>,
  shapes: Map<string, string>,
  budget: MemoryBudget,
): Promise<void> {
  let currentId: string | null = null;
  let current = new ShapePoints();
  for await (const row of rows) {
    const id = row['shape_id'];
    if (!id) continue;
    if (id !== currentId) {
      if (currentId !== null) finish(currentId, current, shapes, budget);
      if (shapes.has(id)) throw new NotGrouped();
      currentId = id;
      current = new ShapePoints();
    }
    const point = readPoint(row);
    if (!point) continue;
    budget.add(POINT_BYTES);
    current.add(point.lat, point.lon, point.seq);
  }
  if (currentId !== null) finish(currentId, current, shapes, budget);
}

/** For a file not grouped by `shape_id`: every shape buffered until its rows are all read. */
async function encodeUngrouped(
  rows: AsyncIterable<Row>,
  shapes: Map<string, string>,
  budget: MemoryBudget,
): Promise<void> {
  const pending = new Map<string, ShapePoints>();
  for await (const row of rows) {
    const id = row['shape_id'];
    if (!id) continue;
    const point = readPoint(row);
    if (!point) continue;
    let points = pending.get(id);
    if (!points) {
      points = new ShapePoints();
      pending.set(id, points);
      budget.add(stringBytes(id) + 64);
    }
    budget.add(POINT_BYTES);
    points.add(point.lat, point.lon, point.seq);
  }
  for (const [id, points] of pending) {
    pending.delete(id);
    budget.release(stringBytes(id) + 64);
    finish(id, points, shapes, budget);
  }
}

/**
 * Reduces `shapes.txt` to one precision-6 polyline per shape (feed-ingest.md "Schedule"): the
 * points ordered by `shape_pt_sequence`, a point with a latitude or longitude that is not a number
 * in range (or no numeric sequence) skipped, the raw points discarded as each shape is encoded.
 *
 * A file grouped by `shape_id` streams through holding one shape at a time. The first time a
 * shape id returns after another shape's rows, the file is known to be ungrouped and is read
 * again, buffering per shape. `open` is called once per read.
 */
export async function encodeShapes(
  open: () => AsyncIterable<Row>,
  budget: MemoryBudget,
): Promise<Map<string, string>> {
  const shapes = new Map<string, string>();
  const before = budget.used;
  try {
    await encodeGrouped(open(), shapes, budget);
    return shapes;
  } catch (error) {
    if (!(error instanceof NotGrouped)) throw error;
  }
  // Drop the partial result of the grouped attempt, then buffer by shape.
  budget.release(budget.used - before);
  shapes.clear();
  await encodeUngrouped(open(), shapes, budget);
  return shapes;
}
