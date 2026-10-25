import type { LatLng } from '@gtfs-rt-debugger/shared';
import type { Row } from './csv.js';
import { distanceMeters, pointsAlong } from './geo.js';

export const TIMEZONE = 'America/Los_Angeles';

/** `agency.txt`: two agencies so that "every row's agency_name" is observable. */
export const AGENCIES: Row[] = [
  {
    agency_id: 'FT',
    agency_name: 'Fixture Transit',
    agency_url: 'https://fixture.example/transit',
    agency_timezone: TIMEZONE,
    agency_lang: 'en',
  },
  {
    agency_id: 'FX',
    agency_name: 'Fixture Express',
    agency_url: 'https://fixture.example/express',
    agency_timezone: TIMEZONE,
    agency_lang: 'en',
  },
];

export const ROUTES: Row[] = [
  {
    route_id: 'R1',
    agency_id: 'FT',
    route_short_name: '1',
    route_long_name: 'Market & Van Ness, Eastbound',
    route_desc: 'Trunk line',
    route_type: '3',
    route_url: 'https://fixture.example/transit/1',
    route_color: '0072BC',
    route_text_color: 'FFFFFF',
  },
  {
    route_id: 'R2',
    agency_id: 'FT',
    route_short_name: '14',
    route_long_name: 'Mission',
    route_desc: '',
    route_type: '3',
    route_url: '',
    route_color: 'D95F02',
    route_text_color: '000000',
  },
  {
    route_id: 'R3',
    agency_id: 'FX',
    route_short_name: 'NX',
    route_long_name: 'Embarcadero "Night" Express',
    route_desc: 'Late service',
    route_type: '3',
    route_url: '',
    route_color: '1B9E77',
    route_text_color: 'FFFFFF',
  },
];

export const STOP_IDS = ['S1', 'S2', 'S3', 'S4', 'S5'] as const;

export const STOPS: Row[] = [
  ['S1', 'Ferry Building', 37.7955, -122.3937],
  ['S2', 'Montgomery', 37.7894, -122.4013],
  ['S3', 'Civic Center', 37.7792, -122.4138],
  ['S4', 'Church', 37.7673, -122.4287],
  ['S5', 'Castro', 37.7625, -122.4351],
].map(([id, name, lat, lon]) => ({
  stop_id: String(id),
  stop_name: String(name),
  stop_lat: String(lat),
  stop_lon: String(lon),
}));

export interface ShapeRow {
  shapeId: string;
  latitude: number;
  longitude: number;
  sequence: number;
  distTraveled: number;
}

interface ShapeDefinition {
  id: string;
  waypoints: LatLng[];
  count: number;
}

const MARKET: ShapeDefinition = {
  id: 'shape-market',
  count: 30,
  waypoints: [
    [37.7937, -122.3965],
    [37.7879, -122.4074],
    [37.7749, -122.4194],
    [37.7647, -122.431],
    [37.7596, -122.4483],
  ],
};
const VAN_NESS: ShapeDefinition = {
  id: 'shape-vanness',
  count: 24,
  waypoints: [
    [37.806, -122.427],
    [37.789, -122.423],
    [37.774, -122.419],
    [37.765, -122.419],
  ],
};
const MISSION: ShapeDefinition = {
  id: 'shape-mission',
  count: 28,
  waypoints: [
    [37.7855, -122.401],
    [37.769, -122.419],
    [37.752, -122.418],
    [37.734, -122.426],
    [37.712, -122.469],
  ],
};
const EMBARCADERO: ShapeDefinition = {
  id: 'shape-embarcadero',
  count: 22,
  waypoints: [
    [37.808, -122.41],
    [37.795, -122.394],
    [37.777, -122.388],
    [37.752, -122.387],
  ],
};

function rowsOf(def: ShapeDefinition): ShapeRow[] {
  const points = pointsAlong(def.waypoints, def.count);
  let travelled = 0;
  return points.map((p, i) => {
    if (i > 0) travelled += distanceMeters(points[i - 1]!, p);
    return {
      shapeId: def.id,
      latitude: p[0],
      longitude: p[1],
      sequence: i + 1,
      distTraveled: Math.round(travelled * 10) / 10,
    };
  });
}

/** Reorders `rows` by the permutation k -> (k * step) mod n; `step` must be coprime with n. */
function scramble<T>(rows: readonly T[], step: number): T[] {
  return rows.map((_, k) => rows[(k * step) % rows.length]!);
}

/**
 * `shapes.txt` in file order. `shape-market` and `shape-vanness` are grouped and ordered. The
 * rows of `shape-mission` and `shape-embarcadero` are shuffled out of `shape_pt_sequence` order
 * and interleaved with each other, so the file is not grouped by `shape_id`.
 */
export function shapeRowsInFileOrder(): ShapeRow[] {
  const mission = scramble(rowsOf(MISSION), 11);
  const embarcadero = scramble(rowsOf(EMBARCADERO), 5);
  const interleaved: ShapeRow[] = [];
  for (let i = 0; i < mission.length; i++) {
    interleaved.push(mission[i]!);
    if (i < embarcadero.length) interleaved.push(embarcadero[i]!);
  }
  return [...rowsOf(MARKET), ...interleaved, ...rowsOf(VAN_NESS)];
}

export const SHAPE_IDS = [MARKET.id, VAN_NESS.id, MISSION.id, EMBARCADERO.id] as const;
export const MISSING_SHAPE_ID = 'shape-gone';

/** The points of every shape in `shape_pt_sequence` order, whatever order the rows were in. */
export function sortedShapePoints(rows: readonly ShapeRow[]): Map<string, LatLng[]> {
  const byShape = new Map<string, ShapeRow[]>();
  for (const row of rows) {
    const list = byShape.get(row.shapeId) ?? [];
    list.push(row);
    byShape.set(row.shapeId, list);
  }
  const result = new Map<string, LatLng[]>();
  for (const [id, list] of byShape) {
    result.set(
      id,
      list.sort((a, b) => a.sequence - b.sequence).map((r): LatLng => [r.latitude, r.longitude]),
    );
  }
  return result;
}
