import { encodePolyline6 } from '@gtfs-rt-debugger/shared';
import { describe, expect, it } from 'vitest';
import { MemoryBudget, stringBytes } from './memory.js';
import { encodeShapes } from './shapes.js';
import type { Row } from './store.js';

/** Rows from CSV text lines, like readCsv gives them; counts how many times the file is opened. */
function source(lines: string[]) {
  const stats = { opens: 0, rowsRead: 0 };
  const open = async function* (): AsyncGenerator<Row> {
    stats.opens++;
    for (const line of lines) {
      stats.rowsRead++;
      const [shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence] = line.split(',');
      yield {
        shape_id: shape_id!,
        shape_pt_lat: shape_pt_lat!,
        shape_pt_lon: shape_pt_lon!,
        shape_pt_sequence: shape_pt_sequence!,
      };
    }
  };
  return { open, stats };
}

const budget = () => new MemoryBudget(1 << 30);

describe('encodeShapes', () => {
  it('encodes a grouped file in one pass, ordered by shape_pt_sequence', async () => {
    const { open, stats } = source([
      'A,10.5,20.5,1',
      'A,10.6,20.7,2',
      'B,-1,-2,5',
      'B,-3,-4,2', // out of order inside its group
    ]);
    const shapes = await encodeShapes(open, budget());
    expect(shapes.get('A')).toBe(
      encodePolyline6([
        [10.5, 20.5],
        [10.6, 20.7],
      ]),
    );
    expect(shapes.get('B')).toBe(
      encodePolyline6([
        [-3, -4],
        [-1, -2],
      ]),
    );
    expect(stats.opens).toBe(1);
  });

  it('keeps file order among points with the same sequence', async () => {
    const { open } = source(['A,1,1,1', 'A,2,2,1', 'A,3,3,1']);
    const shapes = await encodeShapes(open, budget());
    expect(shapes.get('A')).toBe(
      encodePolyline6([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    );
  });

  it('merges a shape split across the file when it is not grouped by shape_id', async () => {
    const { open, stats } = source(['A,1,1,3', 'B,5,5,2', 'A,1,1.5,1', 'B,5,5.5,1', 'A,1,1.2,2']);
    const shapes = await encodeShapes(open, budget());
    expect(shapes.get('A')).toBe(
      encodePolyline6([
        [1, 1.5],
        [1, 1.2],
        [1, 1],
      ]),
    );
    expect(shapes.get('B')).toBe(
      encodePolyline6([
        [5, 5.5],
        [5, 5],
      ]),
    );
    expect(shapes.size).toBe(2);
    expect(stats.opens).toBe(2);
  });

  it('skips points whose latitude, longitude or sequence is not a usable number', async () => {
    const { open } = source([
      'A,1,1,1',
      'A,abc,2,2',
      'A,,2,3',
      'A,2,,4',
      'A,91,2,5',
      'A,-90.1,2,6',
      'A,2,180.5,7',
      'A,2,-181,8',
      'A,NaN,2,9',
      'A,Infinity,2,10',
      'A,0x10,2,11',
      'A,2,2,x',
      'A,3,3,12',
      'A,90,180,13',
      'A,-90,-180,14',
    ]);
    const shapes = await encodeShapes(open, budget());
    expect(shapes.get('A')).toBe(
      encodePolyline6([
        [1, 1],
        [3, 3],
        [90, 180],
        [-90, -180],
      ]),
    );
  });

  it('has no shape for an id without a single valid point, or without an id', async () => {
    const { open } = source(['A,x,y,1', ',1,1,1', 'B,1,1,1']);
    const shapes = await encodeShapes(open, budget());
    expect([...shapes.keys()]).toEqual(['B']);
  });

  it('holds only the raw points of one shape while streaming a grouped file', async () => {
    const lines: string[] = [];
    for (let shape = 0; shape < 200; shape++) {
      for (let seq = 1; seq <= 50; seq++) lines.push(`s${shape},${shape / 10},${seq / 10},${seq}`);
    }
    const tight = new MemoryBudget(100_000);
    const shapes = await encodeShapes(source(lines).open, tight);
    expect(shapes.size).toBe(200);
    // Only the 200 polylines remain charged: 10 000 raw points would have been 320 000 bytes.
    expect(tight.used).toBeLessThan(100_000);
  });

  it('counts the buffering of an ungrouped file toward the limit', async () => {
    const lines: string[] = [];
    for (let seq = 1; seq <= 50; seq++) {
      for (let shape = 0; shape < 200; shape++) {
        lines.push(`s${shape},${shape / 10},${seq / 10},${seq}`);
      }
    }
    await expect(encodeShapes(source(lines).open, new MemoryBudget(100_000))).rejects.toMatchObject(
      { code: 'too_large' },
    );
    const roomy = new MemoryBudget(1 << 30);
    const shapes = await encodeShapes(source(lines).open, roomy);
    expect(shapes.size).toBe(200);
    expect(shapes.get('s7')).toBe(
      encodePolyline6(Array.from({ length: 50 }, (_, i): [number, number] => [0.7, (i + 1) / 10])),
    );
    // After encoding, only the polylines are charged; the raw points are gone.
    expect(roomy.used).toBeLessThan(100_000);
  });

  it('charges only the final shapes after an ungrouped file forces a second read', async () => {
    // A, B and C are flushed by the grouped pass before A returns and shows the file ungrouped.
    const { open, stats } = source([
      'A,1,1,1',
      'B,2,2,1',
      'C,3,3,1',
      'A,1.5,1.5,2',
      'B,2.5,2.5,2',
      'C,3.5,3.5,2',
    ]);
    const used = new MemoryBudget(1 << 30);
    const shapes = await encodeShapes(open, used);
    expect(stats.opens).toBe(2);
    const final = [...shapes].reduce(
      (sum, [id, polyline]) => sum + stringBytes(id) + stringBytes(polyline) + 32,
      0,
    );
    expect(used.used).toBe(final);
  });
});
